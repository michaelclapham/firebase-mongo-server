import express from "express";
import * as admin from "firebase-admin";
import cors from "cors";
import { MongoClient } from "mongodb";
require('dotenv').config();

console.log("Starting...");

const app = express();

app.use(cors());

try {
    let firebaseAdminToken = JSON.parse(process.env.FIREBASE_ADMIN_TOKEN_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(firebaseAdminToken),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
    console.log("Authenticated with firebase admin!");
} catch (ex) {
    console.error("Error authenticating with firebase admin", ex);
}

const mongoClient = new MongoClient(process.env.MONGO_URI);

app.use((req, res, next) => {
    if (req.headers.authorization.startsWith("Bearer ")) {
        const idToken = req.headers.authorization.split("Bearer ")[1];
        admin.auth().verifyIdToken(idToken)
            .then((decodedToken) => {
                req["userId"] = decodedToken.uid;
                req["userEmail"] = decodedToken.email;
                next();
            })
            .catch((err) => {
                res.status(403);
                res.send("Firebase token not valid");
            });
    } else {
        res.status(403);
        res.send("No Firebase token provided");
    }
});

app.get(process.env.PREFIX, async (req, res) => {
    const userId = req["userId"];
    const userEmail = req["userEmail"];
    console.log("Request from... ", userId, userEmail);
    try {
        await mongoClient.connect();
        const database = mongoClient.db('test');
        const collection = database.collection('users');
        const users = await collection.find().toArray();
        res.send(users);
    } catch (ex) {
        res.status(500);
        res.send("Database error");
        console.warn("Database error ", ex);
    } finally {
        mongoClient.close();
    }
});

console.log("All API calls start with prefix ", process.env.PREFIX);
console.log("Listening on port ", process.env.PORT);
app.listen(process.env.PORT);
