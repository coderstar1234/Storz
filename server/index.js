const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const User = require('./models/user')
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('./middlewares/authMiddleware');
const { fs, readFileSync, createWriteStream, unlink, readdirSync, rmSync } = require('fs');
require('dotenv').config();
const jscrypt = require('jscrypt');
const { create } = require("ipfs-http-client");
const fileUpload = require('express-fileupload');

async function ipfsClient() {
    const ipfs = create(
        {
            host: "ipfs.infura.io",
            port: 5001,
            protocol: "https"
        }
    );
    return ipfs;
}

const apiToken = process.env.WEB3_STORAGE_TOKEN

const app = express();
const magic = new Magic(process.env.MAGIC_SECRET_KEY);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//connection to DB

const dburl = process.env.DB_URL;
mongoose.connect(dburl).then(() => { console.log('Connected to StorzDB') })
    .catch((err) => {
        console.log(err)
    })

app.get('/', (req, res) => {
    res.send('Welcome to Storz API v1.0!');
});

app.post("/test", authMiddleware, (req, res) => {
    return res.status(200).json("User can use secure APIs");
});

app.post('/api/user/login', async (req, res) => {
    try {
        console.log("called")
        const didToken = req.headers.authorization.substring(7);
        await magic.token.validate(didToken);
        console.log("user is authenticated");
        return res.status(200).json({ authenticated: true });
    } catch (error) {
        console.log("user is not authenticated");
        return res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/create', authMiddleware, async (req, res) => {
    const magic_id = req.body.magic_id;
    const user_name = req.body.user_name;

    if (!user_name || !magic_id) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const count = await User.count();
    console.log("doc count:" + count);
    if (count == 0) {
        console.log("trying to create a user")
        const encryption_key = uuidv4();
        const user = new User({
            magic_id: magic_id,
            user_name: user_name,
            encryption_key: encryption_key,
            files: []
        })
        console.log("saving user")
        await user.save();
        return res.status(200).json({ message: "User created successfully" });
    }
    else {
        console.log("finding user if exists")
        const user = await User.findOne({ magic_id: magic_id });
        console.log("user: " + user);
        if (user) {
            console.log("User already exists!")
            return res.status(200).json({ message: "User already exists" });
        } else {
            console.log("User not found!")
            try {
                console.log("trying to create a user")
                const encryption_key = uuidv4();
                const user = new User({
                    magic_id: magic_id,
                    user_name: user_name,
                    encryption_key: encryption_key,
                    files: []
                })
                console.log("saving user")
                await user.save();
                return res.status(200).json({ message: "User created successfully" });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }
    }
})

const addFile = async (fileName, filePath) => {
    const file = readFileSync(filePath);
    const ipfs = await ipfsClient();
    const fileAdded = await ipfs.add({ path: fileName, content: file });
    return fileAdded;
}

app.post("/api/upload", authMiddleware, async (req, res) => {
    const metadata = await magic.users.getMetadataByToken(req.headers.authorization.substring(7));
    const user = await User.findOne({ magic_id: metadata.issuer }, { encryption_key: 1 });
    console.log(user);
    if (metadata.issuer === "") {
        return res.status(500).json({ error: "User is not authenticated" });
    }
    // console.log(req.files.files);
    let files = req.files.files;
    //if files is not an array, make it an array
    if (!Array.isArray(files)) {
        files = [files];
    }
    try {
        let uploadList = [];
        //iterate req.files and move it to test folder
        for (let file of files) {
            // const file = files[i];
            const fileName = file.name;
            const filePath = './private/' + fileName;
            const encryptedPath = './encrypted/' + fileName;

            file.mv(filePath, async (err) => {
                if (err) {
                    console.log(err);
                    return res.status(500).json({ error: err.message });
                }

                try {
                    console.log("encrypting file started");
                    jscrypt.encryptFile(
                        filePath,
                        encryptedPath,
                        "aes256",
                        user.encryption_key,
                        655000,
                        async (isDone) => {
                            if (isDone === true) {
                                console.log(fileName + ' is encrypted successfully!');

                                console.log("Adding files to IFPS in next step")
                                const fileAdded = await addFile(fileName, encryptedPath);
                                console.log(fileAdded);

                                let upData = {
                                    file_name: fileAdded.path,
                                    public: false,
                                    cid: fileAdded.cid,
                                    file_creationDate: new Date().toISOString(),
                                    file_size: fileAdded.size
                                };
                                uploadList.push(upData);
                                await User.updateOne({ magic_id: metadata.issuer }, { $push: { files: upData } });
                                
                                unlink(filePath, (err) => {
                                    if (err) {
                                        console.log(err);
                                    }
                                    console.log(filePath + ' is deleted!');
                                })
                                unlink(encryptedPath, (err) => {
                                    if (err) {
                                        console.log(err);
                                    }
                                    console.log(filePath + ' is deleted!');
                                })
                            }
                            else {
                                console.log(fileName + ' is not encrypted!');
                            }
                        }
                    );
                } catch (error) {
                    console.log(error);
                    return res.status(500).json({ error: error.message });
                }

                // unlink(encryptedPath, (err) => {
                //     if (err) {
                //         console.log(err);
                //     }
                //     console.log(fileName + ' is deleted!');
                // })
            })
        }
        return res.status(200).json({ message: "Files uploaded successfully", uploadList: uploadList });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
})

app.get("/api/user/getName/:id", async (req, res) => {
    const magic_id = req.params.id;
    if (!magic_id) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    try {
        const user = await User.findOne({ magic_id: magic_id }, { user_name: 1 });
        return res.status(200).json(user);
    }
    catch (err) {
        return res.status(500).json({ error: err.message });
    }
})


app.listen(8080, () => {
    console.log('Server is running on port 8080');
})