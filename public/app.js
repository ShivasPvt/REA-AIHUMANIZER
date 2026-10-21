const $ = (sel) => document.querySelector(sel);

const SUBMIT_LABELS = { humanize: "Humanize", paraphraser: "Paraphrase", grammar: "Check grammar", generation: "Write" };
const POLL_MS = 2000;

let tool = "humanize";
let config = null;
let result = null; // last completed job's data
let activeVariant = 0;
let rejected = new Set(); // indexes of rejected grammar edits

init();

async function init() {
  document.querySelectorAll(".tabs button").forEach((btn) => btn.addEventListener("click", () => selectTool(btn.dataset.tool)));
  $("#draft").addEventListener("input", updateWordCount);
  $("#file").addEventListener("change", uploadFile);
  $("#form").addEventListener("submit", submit);
  $("#copy").addEventListener("click", copyOutput);

  config = await fetch("/api/config").then((r) => r.json());
  $("#writer-language").innerHTML = Object.entries(config.languages)
    .map(([code, name]) => `<option value="${code}">${name}</option>`)
    .join("");
  showAllowance(config.remaining_words);
  updateWordCount();
}

function selectTool(next) {
  tool = next;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tool === tool)));
  document.querySelectorAll(".options").forEach((el) => (el.hidden = el.dataset.for !== tool));
  $("#draft-block").hidden = tool === "generation";
  $("#submit").textContent = SUBMIT_LABELS[tool];
  setStatus("");
}

function countWords(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

function updateWordCount() {
  const words = countWords($("#draft").value);
  const max = config?.limits.maxWords ?? 3000;
  $("#word-count").textContent = `${words.toLocaleString()} / ${max.toLocaleString()} words`;
}

function showAllowance(remaining) {
  if (remaining == null) return;
  $("#allowance").textContent = `${remaining.toLocaleString()} words left today`;
}

async function uploadFile(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  setStatus("Reading file…");
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/parse-document", { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) return setStatus(body.error, true);
  $("#draft").value = body.text;
  updateWordCount();
  setStatus("");
}

function collectPayload() {
  const payload = { type_generation: tool };
  if (tool !== "generation") payload.text = $("#draft").value;
  const options = document.querySelector(`.options[data-for="${tool}"]`);
  options.querySelectorAll("input, select").forEach((el) => {
    if (el.value !== "") payload[el.name] = el.value;
  });
  return payload;
}

async function submit(event) {
  event.preventDefault();
  const button = $("#submit");
  button.disabled = true;
  setStatus("Sending…");
  try {
    const res = await fetch("/rewrite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPayload()),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);

    const data = await poll(body.job_id);
    if (data.unsupported_language) {
      throw new Error("That language isn't supported. Try English, Spanish, Portuguese, French, German, Italian or Dutch.");
    }
    showResult(data);
    setStatus("Done.");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    button.disabled = false;
    fetch("/api/config").then((r) => r.json()).then((c) => showAllowance(c.remaining_words));
  }
}

async function poll(jobId) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const res = await fetch(`/humanize-jobs/${jobId}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Lost track of the job.");
    if (body.status === "completed") return body.data;
    if (body.status === "failed" || body.status === "cancelled") throw new Error(body.error || "The job failed.");
    setStatus(body.status === "queued" ? "Waiting in queue…" : "Working… this can take up to a minute.");
  }
}

function showResult(data) {
  result = data;
  activeVariant = 0;
  rejected = new Set();
  $("#output-panel").hidden = false;
  renderVariantTabs();
  renderOutput();
  renderEdits();
  $("#output-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderVariantTabs() {
  const tabs = $("#variant-tabs");
  const variants = result.variants || [];
  tabs.hidden = variants.length < 2;
  tabs.innerHTML = "";
  variants.forEach((v, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `Version ${i + 1} · score ${v.score}`;
    btn.setAttribute("aria-selected", String(i === activeVariant));
    btn.addEventListener("click", () => {
      activeVariant = i;
      renderVariantTabs();
      renderOutput();
    });
    tabs.appendChild(btn);
  });
}

function currentText() {
  if (result.variants?.length) return result.variants[activeVariant].text;
  let text = result.text || "";
  // Undo rejected grammar edits by putting the original wording back.
  (result.edits || []).forEach((edit, i) => {
    if (rejected.has(i)) text = text.replace(edit.corrected, edit.original);
  });
  return text;
}

function renderOutput() {
  // textContent, never innerHTML: model output is untrusted.
  $("#output").textContent = currentText();

  const issues = result.variants?.length ? result.variants[activeVariant].fidelity_issues : result.fidelity_issues;
  const box = $("#fidelity");
  box.hidden = !issues?.length;
  box.textContent = issues?.length ? `Check these possible meaning changes: ${issues.join("; ")}` : "";
}

function renderEdits() {
  const edits = result.edits || [];
  $("#edits").hidden = !edits.length;
  const list = $("#edit-list");
  list.innerHTML = "";
  edits.forEach((edit, i) => {
    const li = document.createElement("li");
    const change = document.createElement("span");
    change.className = "change";
    const del = document.createElement("del");
    del.textContent = edit.original;
    const ins = document.createElement("ins");
    ins.textContent = edit.corrected;
    const reason = document.createElement("span");
    reason.className = "reason";
    reason.textContent = `${edit.type}: ${edit.reason}`;
    change.append(del, " → ", ins, reason);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = rejected.has(i) ? "Accept" : "Reject";
    li.classList.toggle("rejected", rejected.has(i));
    toggle.addEventListener("click", () => {
      rejected.has(i) ? rejected.delete(i) : rejected.add(i);
      renderEdits();
      renderOutput();
    });
    li.append(change, toggle);
    list.appendChild(li);
  });
}

async function copyOutput() {
  await navigator.clipboard.writeText(currentText());
  $("#copy").textContent = "Copied";
  setTimeout(() => ($("#copy").textContent = "Copy"), 1500);
}

function setStatus(message, isError = false) {
  const el = $("#status");
  el.textContent = message;
  el.style.color = isError ? "var(--del)" : "";
}
