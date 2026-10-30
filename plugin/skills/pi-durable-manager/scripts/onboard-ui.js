// Browser-tab storage survives refresh but never crosses this loopback origin/port.
const providedToken = location.hash.slice(1);
let token = /^[a-f0-9]{64}$/.test(providedToken) ? providedToken : "";
try {
  if (token) sessionStorage.setItem("pi-setup-token", token);
  else token = sessionStorage.getItem("pi-setup-token") || "";
} catch { /* Initial private link still works when storage is unavailable. */ }
history.replaceState(null, "", "/");
const $ = id => document.getElementById(id);
const form = $("setup");
let polling;
async function api(path, input) {
  const response = await fetch(`/api/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Setup request failed.");
  return data;
}
function disable(value) { for (const element of form.elements) element.disabled = value; }
async function status() {
  try {
    const state = await api("status");
    $("status").textContent = state.message;
    disable(["installing", "done", "existing"].includes(state.phase));
    if (state.phase === "installing" && !polling) polling = setInterval(status, 1500);
    if (state.phase === "done") {
      $("details").textContent = `Version ${state.installation.version}\nService health: verified\nProvider tool calling: not verified\nCoding and GUI wake: not verified\nReturn to Codex to test the selected model before starting work.`;
      clearInterval(polling); polling = undefined;
    } else if (state.phase === "failed" || state.phase === "existing") { clearInterval(polling); polling = undefined; }
  } catch (error) { $("status").textContent = error.message; clearInterval(polling); polling = undefined; }
}
$("discover").addEventListener("click", async () => {
  $("discover").disabled = true;
  try {
    const result = await api("models", { endpoint: $("endpoint").value, allowInsecureHttp: $("insecure").checked, key: $("key").value });
    $("models").replaceChildren(...result.models.map(id => { const option = document.createElement("option"); option.value = id; return option; }));
    if (result.models.length === 1) $("model").value = result.models[0];
    $("discovery").textContent = result.models.length ? `${result.models.length} model(s) found. Choose one below.` : "No models advertised. Enter the exact model ID below.";
  } catch (error) { $("discovery").textContent = error.message; }
  finally { $("discover").disabled = false; }
});
form.addEventListener("submit", async event => {
  event.preventDefault(); disable(true);
  try {
    await api("install", { endpoint: $("endpoint").value, allowInsecureHttp: $("insecure").checked, key: $("key").value, contextWindow: Number($("contextWindow").value), maxTokens:Number($("maxTokens").value), reasoning:$("reasoning").checked, model: $("model").value, noAuth: $("noAuth").checked, allowNetwork: $("network").checked, permissions: {writeFiles: $("writeFiles").checked, shell: $("shell").checked, network: $("network").checked, hostValidation: $("hostValidation").checked, excludedPaths: []} });
    $("key").value = "";
    $("status").textContent = "Installing Pi Durable. Keep this page open…";
    if (!polling) polling = setInterval(status, 1500);
    await status();
  } catch (error) { $("status").textContent = error.message; disable(false); }
});
if (!token) { disable(true); $("status").textContent = "Open the private setup link provided by Codex."; }
else await status();

$("writeFiles").onchange=()=>{if(!$("writeFiles").checked)$("shell").checked=false;};
$("shell").onchange=()=>{if($("shell").checked)$("writeFiles").checked=true;};
