# remote-pi relay

Self-hosted relay for [Remote Pi](https://github.com/ZainCheung/remote_pi)
(the iOS app that controls a live pi session). Traffic between the phone and
pi is TLS-only, not end-to-end encrypted, so the relay must be ours.

```sh
cd infra/remote-pi-relay
terraform init && terraform apply
terraform output relay_url       # https://remote-pi-relay-….a.run.app
```

Then in pi: `/remote-pi relay url <that URL>`, then `/remote-pi` → scan the QR with
the app. Cloud Run, Jakarta, one always-on 512 MiB instance (~US$15/month).
Upgrade the relay with `terraform apply -var image_tag=<tag>` (or `latest` +
`terraform apply -replace=google_cloud_run_v2_service.relay`).
