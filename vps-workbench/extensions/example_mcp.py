"""Small stdio MCP example that returns a fixed status."""
import json
import sys

TOOL = {
    "name": "workbench_status",
    "description": "Return the status of this example MCP service.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}


def handle(method, params):
    if method == "initialize":
        return {"protocolVersion": params["protocolVersion"], "capabilities": {"tools": {}},
                "serverInfo": {"name": "workbench-example", "version": "1.0.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method == "tools/call" and params.get("name") == TOOL["name"]:
        return {"content": [{"type": "text", "text": "VPS workbench MCP ready"}]}
    raise ValueError("unknown method or tool")


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    response = {"jsonrpc": "2.0", "id": request["id"]}
    try:
        response["result"] = handle(request.get("method"), request.get("params") or {})
    except (KeyError, ValueError):
        response["error"] = {"code": -32601, "message": "Method or tool unavailable"}
    print(json.dumps(response, separators=(",", ":")), flush=True)
