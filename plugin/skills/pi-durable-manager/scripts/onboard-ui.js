const token = location.hash.slice(1);
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
    if (state.phase === "done") {
      $("details").textContent = `Version ${state.installation.version}\nService health: verified\nNo coding request has been sent to your provider yet.`;
      clearInterval(polling);
    } else if (state.phase === "failed" || state.phase === "existing") clearInterval(polling);
  } catch (error) { $("status").textContent = error.message; clearInterval(polling); }
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
    await api("install", { endpoint: $("endpoint").value, allowInsecureHttp: $("insecure").checked, key: $("key").value, contextWindow: Number($("contextWindow").value), maxTokens:Number($("maxTokens").value), reasoning:$("reasoning").checked, model: $("model").value, noAuth: $("noAuth").checked, allowNetwork: $("network").checked });
    $("key").value = "";
    $("status").textContent = "Installing Pi Durable. Keep this page open…";
    polling = setInterval(status, 1500);
    await status();
  } catch (error) { $("status").textContent = error.message; disable(false); }
});
if (!token) { disable(true); $("status").textContent = "Open the private setup link provided by Codex."; }
else await status();
