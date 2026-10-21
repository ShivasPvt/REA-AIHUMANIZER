import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DAILY_WORDS, charge, refund, remaining } from "./allowance.js";
import { enqueue, getJob } from "./jobs.js";
import { LIMITS, ValidationError, prepare } from "./tools.js";
import { LANGUAGES } from "./text.js";
import { MODEL } from "./llm.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// A number means "trust that many proxy hops" (Render needs 1); otherwise Express parses it as IPs/subnets.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

const visitorOf = (req) => req.ip;

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/api/config", (req, res) => {
  res.json({ limits: LIMITS, languages: LANGUAGES, daily_words: DAILY_WORDS, remaining_words: remaining(visitorOf(req)) });
});

function rewrite(req, res) {
  let job;
  try {
    job = prepare(req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) return res.status(422).json({ error: err.message });
    throw err;
  }
  const visitor = visitorOf(req);
  if (!charge(visitor, job.words)) {
    return res.status(429).json({ admission: "limit", error: `Daily allowance of ${DAILY_WORDS.toLocaleString()} words reached. Try again tomorrow.` });
  }
  const run = () =>
    job.run().catch((err) => {
      refund(visitor, job.words);
      throw err;
    });
  res.json({ queued: true, job_id: enqueue(run) });
}

app.post("/rewrite", rewrite);
app.post("/:lang/rewrite", rewrite);

app.get("/humanize-jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const body = { status: job.status };
  if (job.status === "completed") body.data = job.data;
  if (job.status === "failed") body.error = job.error;
  res.json(body);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

app.post("/parse-document", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(422).json({ error: "Attach one file." });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let text;
    if (ext === ".docx") {
      text = (await mammoth.extractRawText({ buffer: req.file.buffer })).value;
    } else if ([".txt", ".md"].includes(ext)) {
      text = req.file.buffer.toString("utf8");
    } else {
      return res.status(415).json({ error: "Upload a .txt, .md or .docx file." });
    }
    res.json({ text: text.replace(/\r\n/g, "\n").trim() });
  } catch (err) {
    console.error("parse-document failed:", err);
    res.status(422).json({ error: "Could not read that file." });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(413).json({ error: "File must be under 5 MB." });
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

app.listen(PORT, () => {
  console.log(`REA AI Humanizer on http://localhost:${PORT} (model: ${MODEL})`);
});
