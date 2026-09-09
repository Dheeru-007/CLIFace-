import path from "path";
import os from "os";
import fs from "fs";
import { createServer } from "./server.js";

const PORT = 3000;
const tmpDir = path.join(os.tmpdir(), "cliface-tmp");
const outputDir = path.join(process.cwd(), "output");
const schemasDir = path.join(process.cwd(), "src", "schemas");
const historyFilePath = path.join(process.cwd(), "history.jsonl");

// Ensure directories exist
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const { app } = createServer(tmpDir, outputDir, schemasDir, historyFilePath);

app.listen(PORT, () => {
    console.log(`Backend server listening on http://localhost:${PORT}`);
});
