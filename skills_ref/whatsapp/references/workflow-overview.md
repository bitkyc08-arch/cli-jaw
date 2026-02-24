# Workflow Overview

## Key behaviors

- Workflows are automation graphs; an execution moves node-to-node until it waits or ends.
- Trigger inbound_message: if a non-observer execution is running or waiting for that conversation, the message routes to it. If in handoff, workflow processing is skipped. Otherwise, a new execution starts.
- Trigger api_call: starts an execution from the API; context channel is api.
- Trigger whatsapp_event: starts an observer execution for each matching event; observer executions are read-only by default (allow_outbound: false).

## Execution states

- running: processing steps.
- waiting: paused waiting for user input (wait_for_response or agent nodes).
- handoff: halted for human takeover; automation does not process inbound messages.
- ended: terminal success.
- failed: terminal error; error_details recorded.

Valid transitions:
- running -> waiting | ended | failed | handoff
- waiting -> running | ended | failed | handoff
- handoff -> running | ended | failed
- ended/failed have no transitions
