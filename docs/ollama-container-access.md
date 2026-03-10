# Ollama Container Access Setup

Step-by-step guide to give container agents access to the local Qwen model.

## Prerequisites

- Ollama running with Qwen model: `ollama list` should show `qwen-local` or your configured model
- NanoClaw running with Apple Containers

## Step 1: Enable the config flag

Add to your `.env`:
```
OLLAMA_CONTAINER_ACCESS=true
```

This injects `OLLAMA_BASE_URL` and `OLLAMA_MODEL` environment variables into every container. No network changes yet — containers still can't reach Ollama because it only listens on localhost.

## Step 2: Bind Ollama to all interfaces

```bash
launchctl setenv OLLAMA_HOST "0.0.0.0"
brew services restart ollama
```

Now Ollama listens on all network interfaces. Containers can reach it via the host gateway IP (default: 192.168.64.1).

**Security note**: This also exposes Ollama to your local network. On trusted home WiFi this is low risk. On public WiFi, anyone on the network can query your model.

## Step 3: Firewall rules (recommended)

Restrict Ollama access to localhost + container subnet only:

```bash
sudo pfctl -e 2>/dev/null
echo "block in on ! lo0 proto tcp to port 11434
pass in on lo0 proto tcp to port 11434
pass in proto tcp from 192.168.64.0/24 to port 11434" | sudo pfctl -f -
```

To make this persistent across reboots, add to `/etc/pf.conf`.

## Step 4: Verify

From inside a container:
```bash
curl -s http://192.168.64.1:11434/api/tags
```

Should return a JSON list of available models.

## Custom host IP

If your container subnet uses a different gateway, set:
```
OLLAMA_CONTAINER_HOST=192.168.X.1
```

Find your gateway: `container exec <name> ip route | grep default`

## Disabling

Remove `OLLAMA_CONTAINER_ACCESS=true` from `.env` and restart NanoClaw. Containers will no longer have the Ollama URL in their environment.
