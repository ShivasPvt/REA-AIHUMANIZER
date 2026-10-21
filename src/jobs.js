import crypto from "node:crypto";

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_JOBS || 4);

let running = 0;
const queue = [];

// Queues `run` and returns its id; GET /humanize-jobs/:id reports progress.
export function enqueue(run) {
  const id = crypto.randomUUID();
  jobs.set(id, { status: "queued", created: Date.now() });
  queue.push({ id, run });
  pump();
  return id;
}

export function getJob(id) {
  return jobs.get(id);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const { id, run } = queue.shift();
    const job = jobs.get(id);
    job.status = "running";
    running++;
    run()
      .then((data) => {
        job.status = "completed";
        job.data = data;
      })
      .catch((err) => {
        console.error(`job ${id} failed:`, err);
        job.status = "failed";
        job.error = err.code === "refusal" || err.code === "max_tokens" ? err.message : "Something went wrong. Please try again.";
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.created < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();
