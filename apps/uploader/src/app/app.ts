import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import prettyBytes from 'pretty-bytes';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { pipeline } from 'node:stream';
import crypto from 'node:crypto';
import { Utils } from '@secretarium/connector';
import KeyHolder from '../utils/keyHolder';
const pump = util.promisify(pipeline);

const uploadFolder = process.env.NX_APP_UPLOAD_FOLDER ?? 'uploads';
const fileSizeLimit = typeof process.env.MAX_FILE_SIZE === 'string' ? parseInt(process.env.MAX_FILE_SIZE) : 8589934592;
const definitions = process.env.KLAVE_DISPATCH_ENDPOINTS?.split(',') ?? [];
const endpoints = definitions.map(def => def.split('#') as [string, string]).filter(def => def.length === 2);
// const connectionPool = new Map<string, WebSocket>();

/* eslint-disable-next-line */
export interface AppOptions { }

export async function app(fastify: FastifyInstance) {

    fastify.log.info(endpoints, 'Preparing for enpoints');

    fastify.post('/file', async function (req, res) {

        const data = await req.file();

        if (!data)
            return res.status(400).send({ error: 'No file uploaded' });

        const tokenField = data.fields['token'];
        const tokenPart = Array.isArray(tokenField) ? tokenField[0] : tokenField;
        const tokenB64 = tokenPart?.type === 'field' ? tokenPart.value as string : undefined;

        if (!tokenB64)
            return res.status(400).send({ error: 'Token is missing' });

        const token = Utils.fromBase64(tokenB64);
        const tokenContent = token.subarray(0, 32 + 8);
        const tokenContentB64 = Utils.toBase64(tokenContent, false);
        const expectedDigest = tokenContent.subarray(0, 32);
        const signature = token.subarray(32 + 8);

        if (!KeyHolder.roomKey)
            return res.status(500).send({ error: 'The data room key is missing' });
        if (!KeyHolder.signKey)
            return res.status(500).send({ error: 'The signing key is missing' });

        const isValid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, KeyHolder.roomKey, signature, Buffer.from(tokenContentB64));

        if (!isValid)
            return res.status(400).send({ error: 'The signature could not be verified' });

        const stream = data.file;
        const hash = crypto.createHash('sha256');
        let readBytes = 0;

        stream.pause();

        /* if the client cancelled the request mid-stream it will throw an error */
        stream.on('error', () => {
            res.status(400).send({ error: 'The client aborted the upload' });
        });

        stream.on('data', (chunk) => {
            readBytes += chunk.length;
            if (readBytes > fileSizeLimit) {
                stream.destroy();
                console.log(`The file should not be larger than ${prettyBytes(fileSizeLimit)}`);
                return;
            }
            hash.update(chunk);
        });

        const fileName = Utils.toBase64(expectedDigest, true);
        const destinationBase = path.join(__dirname, uploadFolder, `${fileName[0]}`, `${fileName[1]}`, `${fileName[2]}`, `${fileName[3]}`, `${fileName[4]}`);
        fs.mkdirSync(destinationBase, {
            recursive: true
        });

        const temporaryFileName = uuid({ random: new Uint8Array(expectedDigest) });
        const temporaryDestination = path.join(destinationBase, temporaryFileName);

        const finishProcessing = async () => {

            const digest = hash.digest()
            const digestB64 = Utils.toBase64(digest, true)

            if (fileName !== digestB64) {
                fs.rmSync(temporaryDestination);
                return res.status(400).send({ error: 'The file digest did not match the expected value' });
            } else {
                const destination = path.join(destinationBase, fileName);
                fs.renameSync(temporaryDestination, destination);
            }

            const proofSign = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, KeyHolder.signKey, Buffer.from(tokenContentB64));
            const resultToken = new Uint8Array(40 + 64);
            resultToken.set(tokenContent, 0);
            resultToken.set(new Uint8Array(proofSign), 40);

            const resultTokenB64 = Utils.toBase64(resultToken, false);
            res.status(200).send({ ok: true, uploadToken: resultTokenB64 });
        }

        stream.on('close', () => {
            finishProcessing().catch((error) => {
                console.error('Error while processing the file', error);
                res.status(500).send({ error: 'An error occurred while processing the file' });
            })
        });

        await pump(data.file, fs.createWriteStream(temporaryDestination));
    });

    fastify.get('/file', async function (req, res) {

         res.header('content-type', 'application/json');
        const data = req.headers.authorization?.split(';').find((part: string) => part.startsWith('klavedr='))

        if (!data)
            return res.status(400).send({ error: 'No query provided' });

        const tokenB64 = data.split('=')[1]

        if (!tokenB64)
            return res.status(400).send({ error: 'Token is missing' });

        const token = Utils.fromBase64(tokenB64);
        const tokenContent = token.subarray(0, 32 + 8);
        const digest = tokenContent.subarray(0, 32);

        const fileName = Utils.toBase64(digest, true);
        const locationBase = path.join(__dirname, uploadFolder, `${fileName[0]}`, `${fileName[1]}`, `${fileName[2]}`, `${fileName[3]}`, `${fileName[4]}`);
        const location = path.join(locationBase, fileName);

        const stream = fs.createReadStream(location);

         res.header('content-type', 'application/octet-stream');
         res.header('content-disposition', `attachment; filename="${fileName}"`);

        return res.send(stream);
    });

    fastify.get('/version', async (__unusedReq, res) => {
        await res.status(200).send({
            version: {
                name: process.env.NX_TASK_TARGET_PROJECT,
                commit: process.env.GIT_REPO_COMMIT?.substring(0, 8),
                branch: process.env.GIT_REPO_BRANCH,
                version: process.env.GIT_REPO_VERSION
            }
        });
    });
}
