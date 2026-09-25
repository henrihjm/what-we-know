# Running the loop on EC2

Goal: the nor'easter loop runs on a small instance (t3.small is plenty) from mid-afternoon while laptops are used for the dashboard and demo. The loop is stateless between cycles: state lives in RawTree, so the instance can be replaced at any time.

## 1. Instance

- Amazon Linux 2023 or Ubuntu 24.04, t3.small, 8 GB disk, security group with outbound HTTPS only (open inbound 3000 only if you want the dashboard served from EC2).
- Attach an IAM role with `bedrock:InvokeModel` and `bedrock:Converse` on the model you set as `BEDROCK_MODEL_ID`. Then no AWS keys are needed in `.env`; the SDK uses the instance role. Make sure the model is enabled in the Bedrock console for `AWS_REGION`.

## 2. Install Node 22 and clone

```bash
# Amazon Linux 2023
sudo dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
# Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git

git clone https://github.com/<you>/what-we-know.git
cd what-we-know
npm ci
cp .env.example .env
nano .env        # paste keys; leave AWS_ACCESS_KEY_ID empty when using the instance role
npm run check-env
```

## 3a. Quick start with nohup

```bash
nohup npm run loop > loop-noreaster.log 2>&1 &
nohup npm run loop:hormuz > loop-hormuz.log 2>&1 &
tail -f loop-noreaster.log
```

## 3b. systemd unit (survives reboots)

```bash
sudo tee /etc/systemd/system/wwk-noreaster.service > /dev/null <<'UNIT'
[Unit]
Description=What We Know loop (noreaster)
After=network-online.target

[Service]
WorkingDirectory=/home/ec2-user/what-we-know
ExecStart=/usr/bin/npm run loop
Restart=always
RestartSec=15
User=ec2-user
EnvironmentFile=/home/ec2-user/what-we-know/.env

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now wwk-noreaster
journalctl -u wwk-noreaster -f
```

Copy the unit as `wwk-hormuz.service` with `ExecStart=/usr/bin/npm run loop:hormuz` for the second story.

## 4. Docker alternative

```bash
docker build -t what-we-know .
docker run -d --restart unless-stopped --env-file .env --name wwk-noreaster what-we-know
docker run -d --restart unless-stopped --env-file .env --name wwk-hormuz what-we-know npm run loop:hormuz
```

## 5. Kill and restart

```bash
sudo systemctl restart wwk-noreaster     # or: kill <pid> && nohup npm run loop ... &
```

The log shows `ledger from rawtree (cycle N, ...)` and then `cycle N+1 | ...`: the loop resumes from the last ledger version in RawTree with no manual step. The lock file in `state/` is per story and is taken over automatically if the old pid is gone.
