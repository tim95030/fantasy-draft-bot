# Deploy on Oracle Cloud (Always Free)

This bot only needs **outbound** internet (to Discord). You do **not** need to open Discord ports inbound — only **SSH (22)** so you can log into the VM.

## 1) Create an Always Free VM

In [Oracle Cloud Console](https://cloud.oracle.com):

1. **Compute → Instances → Create instance**
2. Suggested settings:
   - **Name:** `fantasy-draft-bot`
   - **Image:** Canonical Ubuntu 22.04 or 24.04
   - **Shape:** Always Free eligible  
     - Prefer **VM.Standard.A1.Flex** (Ampere ARM): 1 OCPU, 6 GB RAM is plenty  
     - Or **VM.Standard.E2.1.Micro** (AMD) if Ampere isn’t available in your region
3. **Networking:** use the default VCN / public subnet, assign a **public IP**
4. **SSH keys:** upload your public key (or generate one and save the private key)
5. Create the instance and wait until state is **Running**
6. Copy the **Public IP address**

### Allow SSH (once)

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List → Add Ingress Rules:**

- Source: your home IP `/32` (or `0.0.0.0/0` if you must — less safe)
- Destination port: `22`
- Protocol: TCP

No other ingress rules are required for the Discord bot.

## 2) SSH in

```bash
# Replace with your key path and VM IP
ssh -i ~/.ssh/your-oracle-key ubuntu@YOUR_VM_PUBLIC_IP
```

(On some images the user is `opc` instead of `ubuntu`.)

## 3) Install Node.js 20+

On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

## 4) Clone and configure the bot

```bash
cd ~
git clone https://github.com/tim95030/fantasy-draft-bot.git
cd fantasy-draft-bot
npm install

cp .env.example .env
nano .env   # or vim
```

Set at least:

```env
DISCORD_TOKEN=your_real_bot_token
CLIENT_ID=1555263710270988298
GUILD_ID=your_server_id
```

Save and exit (`Ctrl+O`, Enter, `Ctrl+X` in nano).

Register slash commands (once):

```bash
npm run register-commands
```

## 5) Run it under systemd (survives reboot)

```bash
sudo cp deploy/fantasy-draft-bot.service /etc/systemd/system/
sudo sed -i "s|REPLACE_USER|$(whoami)|g" /etc/systemd/system/fantasy-draft-bot.service
sudo sed -i "s|REPLACE_HOME|$HOME|g" /etc/systemd/system/fantasy-draft-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now fantasy-draft-bot
sudo systemctl status fantasy-draft-bot
```

Useful commands:

```bash
sudo journalctl -u fantasy-draft-bot -f    # live logs
sudo systemctl restart fantasy-draft-bot   # after .env or code changes
sudo systemctl stop fantasy-draft-bot
```

You should see `Logged in as fantasy-draft-bot#....` in the logs.

## 6) Player data & Discord setup

With the bot online:

1. `/draft-import-players` (attach your CSV), **or** `scp` a file to `~/fantasy-draft-bot/data/players.csv` and restart the service
2. `/draft-setup channel:#your-draft-channel ...`
3. `/draft-order set ...`
4. `/draft-start`

### Upload a CSV from your Mac

```bash
scp -i ~/.ssh/your-oracle-key /path/to/players.csv ubuntu@YOUR_VM_PUBLIC_IP:~/fantasy-draft-bot/data/players.csv
ssh -i ~/.ssh/your-oracle-key ubuntu@YOUR_VM_PUBLIC_IP 'sudo systemctl restart fantasy-draft-bot'
```

## 7) Updating code later

```bash
cd ~/fantasy-draft-bot
git pull
npm install
npm run register-commands   # only if commands changed
sudo systemctl restart fantasy-draft-bot
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Can’t SSH | Check public IP, security list port 22, correct key/user (`ubuntu` vs `opc`) |
| Bot never comes online | `journalctl -u fantasy-draft-bot -n 50` — usually bad/missing `DISCORD_TOKEN` |
| Slash commands missing | Set `GUILD_ID`, run `npm run register-commands` |
| `Used disallowed intents` | Enable Message Content + Server Members in Discord Dev Portal → Bot |

## Security

- Keep `.env` only on the VM (never commit it)
- Prefer SSH from your IP only
- Rotate the Discord token if it ever leaks
