/**
 * Deterministic loopback OpenAI-compatible fixture provider for the offline
 * end-to-end check.
 *
 * This is a REAL HTTP server that speaks the OpenAI Chat Completions streaming
 * protocol. The production `modal` provider transport (pi-ai's
 * `openAICompletionsApi`) dials it through the UNCHANGED code path — the only
 * thing that is scripted is the model's tool-call decisions, which are
 * deterministic and content-addressed to the assignment's task text.
 *
 * It is NOT a production sandbox bypass and NOT a test-mode backdoor: it lives
 * outside `src/`-runtime behaviour, is only ever started by the `check` command
 * (human/manager initiated), and never appears in the service's normal startup
 * path. The service always uses the real Modal provider; the fixture merely
 * impersonates the *endpoint*.
 *
 * The scripted behaviour for one bounded sample assignment is:
 *   1. Request 1 → a `write` tool call creating `hello.txt` with fixed bytes.
 *   2. Request 2 → a `bash` tool call running a real test command.
 *   3. Request 3 → a final assistant text message with NO tool calls (done).
 * Later requests (e.g. an accidental extra loop) also return the final message
 * so the bounded loop can never spin forever.
 */
import { createServer } from "node:http";
import {} from "node:net";
/** Deterministic file the fixture writes into the sandboxed project. */
export const FIXTURE_FILE_NAME = "hello.txt";
/** Exact bytes the fixture writes; the check asserts these verbatim. */
export const FIXTURE_FILE_CONTENT = "hello from the deterministic fixture\n";
/** The command the fixture asks the worker to run (a real, sandboxed exec). */
export const FIXTURE_TEST_COMMAND = "cat hello.txt && echo FIXTURE_TEST_OK";
function readBody(req) {
    return new Promise((resolvePromise, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
function parseRequest(raw) {
    try {
        const parsed = JSON.parse(raw);
        const model = typeof parsed.model === "string" ? parsed.model : null;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        const toolNames = tools
            .map((t) => t?.function?.name)
            .filter((n) => typeof n === "string");
        return { model, messageCount: messages.length, toolNames };
    }
    catch {
        return { model: null, messageCount: 0, toolNames: [] };
    }
}
/**
 * Decide the scripted assistant turn for request `index`.
 *
 * Deterministic and content-free: the decision depends only on how many prior
 * requests we have served, so the sequence is reproducible run to run.
 */
function scriptedTurn(index, command = FIXTURE_TEST_COMMAND) {
    if (index === 0) {
        return {
            toolCall: { name: "write", args: { path: FIXTURE_FILE_NAME, content: FIXTURE_FILE_CONTENT } },
            text: "",
        };
    }
    if (index === 1) {
        return {
            toolCall: { name: "bash", args: { command } },
            text: "",
        };
    }
    return { text: "Fixture assignment complete: wrote hello.txt and ran the test." };
}
function chunkBase(id, model, created) {
    return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
    };
}
function writeSse(res, obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
/** Serve one scripted assistant turn as an OpenAI streaming completion. */
function serveTurn(res, model, turn) {
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    const id = `chatcmpl-fixture-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const base = chunkBase(id, model, created);
    // Role preamble.
    writeSse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    if (turn.toolCall !== undefined) {
        const callId = `call_fixture_${turn.toolCall.name}`;
        // Announce the tool call with the full function name, then stream the
        // arguments JSON (mirrors how real providers stream tool_calls).
        writeSse(res, {
            ...base,
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            { index: 0, id: callId, type: "function", function: { name: turn.toolCall.name, arguments: "" } },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        });
        writeSse(res, {
            ...base,
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [{ index: 0, function: { arguments: JSON.stringify(turn.toolCall.args) } }],
                    },
                    finish_reason: null,
                },
            ],
        });
        writeSse(res, {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
    }
    else {
        writeSse(res, {
            ...base,
            choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }],
        });
        writeSse(res, {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
    }
    res.write("data: [DONE]\n\n");
    res.end();
}
/**
 * Start the fixture server bound to loopback on an ephemeral port.
 *
 * The returned `baseUrl` is `http://127.0.0.1:<port>/v1`; the production
 * transport appends `/chat/completions`.
 */
export async function startFixtureServer(options) {
    const requests = [];
    let counter = 0;
    const delayMs = Math.max(0, options?.delayMs ?? 0);
    const server = createServer((req, res) => {
        void (async () => {
            const url = req.url ?? "/";
            if (req.method !== "POST" || !url.includes("/chat/completions")) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `fixture: no route for ${url}` } }));
                return;
            }
            const raw = await readBody(req);
            const parsed = parseRequest(raw);
            const index = counter++;
            requests.push({
                index,
                model: parsed.model,
                messageCount: parsed.messageCount,
                toolNames: parsed.toolNames,
            });
            if (delayMs > 0)
                await new Promise((r) => setTimeout(r, delayMs));
            serveTurn(res, parsed.model ?? "fixture-model", scriptedTurn(index, options?.command));
        })().catch((error) => {
            try {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: `fixture error: ${error.message}` } }));
            }
            catch {
                // response already gone
            }
        });
    });
    await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    const port = address.port;
    return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        requestCount: () => counter,
        close: () => new Promise((resolvePromise) => {
            server.close(() => resolvePromise());
        }),
    };
}
//# sourceMappingURL=check-fixture.js.map