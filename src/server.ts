import express from "express";
import * as admin from "firebase-admin";
import cors from "cors";
import { MongoClient, UpdateQuery } from "mongodb";
import { auth } from "firebase-admin";
import bodyParser from "body-parser";
import * as http from "http";
require('dotenv').config();

console.log("Starting...");

const app = express();
let expressServer: http.Server;

app.use(cors());

app.use(bodyParser.json());

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


async function setup() {
    try {
        console.log("Connecting to MongoDB...");
        await mongoClient.connect();
        console.log("Connected to MongoDB!");

        setupAPIEndpoints();

        console.log("All API calls start with prefix ", process.env.PREFIX);
        console.log("Listening on port ", process.env.PORT);
        expressServer = app.listen(process.env.PORT);


    } catch (ex) {
        console.error("Failed to connect to MongoDB ", ex);
    }
}

async function cleanup() {
    console.log("Closing express server...");
    expressServer.close();
    console.log("Express server closed");
    console.log("Closing MongoDB connection");
    await mongoClient.close();
    console.log("MongoDB connection closed");
    
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
setup();

function setupAPIEndpoints() {

    app.use((req, res, next) => {
        if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
            const idToken = req.headers.authorization.split("Bearer ")[1];
            admin.auth().verifyIdToken(idToken)
                .then((decodedToken) => {
                    req["userId"] = decodedToken.uid;
                    req["userEmail"] = decodedToken.email;

                    /* Allow admins to act on behalf of other users */
                    let oboAdminEmails = [];
                    if (process.env.OBO_ADMIN_EMAILS) {
                        oboAdminEmails = process.env.OBO_ADMIN_EMAILS.split(",");
                    }
                    req["isOboAdmin"] = oboAdminEmails.indexOf(decodedToken.email) > -1;
                    let effectiveUserId = req["userId"];
                    if (req["isOboAdmin"] && req.query["oboUserId"]) {
                        effectiveUserId = req.query["oboUserId"];
                    }
                    req["effectiveUserId"] = effectiveUserId;
                    next();
                })
                .catch((err) => {
                    res.status(403);
                    res.send({ error: "Firebase token not valid"});
                });
        } else {
            res.status(403);
            res.send({ error: "No Firebase token provided"});
        }
    });

    app.get(process.env.PREFIX + "/users", async (req, res) => {
        if (req["isOboAdmin"]) {
            const maxResults = req.query.maxResults ? Number.parseInt(req.query.maxResults as string) : undefined;
            const pageToken = req.query.pageToken ? req.query.pageToken + "" : undefined;
            const firebaseUsers = await admin.auth().listUsers(maxResults, pageToken);
            res.contentType("json");
            res.send(JSON.stringify(firebaseUsers, null, 4));
        } else {
            res.status(403);
            res.send({ error: "You must be an admin to make this call"});
        }
    });

    app.get(process.env.PREFIX + "/current-user", async (req, res) => {
        const userId = req["userId"];
        const userEmail = req["userEmail"];
        const isOboAdmin = req["isOboAdmin"];
        const effectiveUserId = req["effectiveUserId"];

        const firebaseUserRecord = await admin.auth().getUser(userId);

        res.contentType("json");
        res.send(JSON.stringify({
            userId: userId,
            userEmail: userEmail,
            displayName: firebaseUserRecord.displayName,
            oboAdmin: isOboAdmin
        }, null, 4));
    });

    app.get(process.env.PREFIX + "/current-user/:property", async (req, res) => {
        const userId = req["userId"];
        const effectiveUserId = req["effectiveUserId"];
        console.log(`Request from actual user id : ${userId}, effective user id : ${effectiveUserId}`);
        try {
            const database = mongoClient.db(process.env.MONGO_DATABASE_NAME);
            const usersCollection = database.collection('users');
            const matchingUser = await usersCollection.findOne({ firebaseUserId: effectiveUserId });
            if (matchingUser) {
                const data = matchingUser[req.params.property];
                res.send(data);
            } else {
                res.status(404);
                res.send({ msg: "No user found with id " + effectiveUserId});
            }
        } catch (ex) {
            res.status(500);
            res.send({ error: "Database error", ex: ex });
            console.warn("Database error ", ex);
        }
    });

    app.post(process.env.PREFIX + "/current-user/:property", async (req, res) => {
        const userId = req["userId"];
        const effectiveUserId = req["effectiveUserId"];
        console.log(`Request from actual user id : ${userId}, effective user id : ${effectiveUserId}`);
        try {
            const database = mongoClient.db(process.env.MONGO_DATABASE_NAME);
            const usersCollection = database.collection('users');
            const query = { firebaseUserId: effectiveUserId };
            let update: UpdateQuery<any> = { $set: { firebaseUserId: effectiveUserId, [req.params.property]: req.body } };
            usersCollection.updateOne(query, update, { upsert: true });
            res.status(200);
            res.send({ msg: "success" });
        } catch (ex) {
            res.status(500);
            res.send("Database error");
            console.warn("Database error ", ex);
        }
    });
}

