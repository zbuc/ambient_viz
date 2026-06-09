# Kiosk deployment artifacts — Daisy WebUSB audio capture

Two host-config files needed **only** when the kiosk runs live USB audio capture
(`?usbaudio=1`) off the Daisy `usb-bulk` firmware. They are *not* needed for the
default `localaudio` mode. A reimage/reflash of the Pi loses anything under
`/etc/`, so these live in the repo — re-apply them after provisioning.

| File | Installs to | Purpose |
|---|---|---|
| `99-daisy-webusb.rules` | `/etc/udev/rules.d/` | grants the seat user raw USB access so Chromium can `claimInterface()` the Daisy's vendor bulk-audio interface |
| `webusb-policy.json` | `/etc/chromium/policies/managed/` | pre-authorizes the Daisy for WebUSB so `?usbaudio=1` auto-connects with no gesture |

## Install

```bash
sudo cp kiosk/99-daisy-webusb.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger    # then replug the Daisy

sudo mkdir -p /etc/chromium/policies/managed
sudo cp kiosk/webusb-policy.json /etc/chromium/policies/managed/
# restart Chromium; confirm at chrome://policy
```

## Caveats

- `webusb-policy.json` `urls` must match the kiosk origin exactly (scheme+host+port).
  Default is `http://localhost:8080`.
- The udev rule's `TAG+="uaccess"` grants the **active graphical seat** user. For a
  headless/systemd-service context use the `plugdev` group form noted in the
  `.rules` file header.
- The Daisy must be flashed with a `usb-bulk` firmware image. Preferred:
  `cargo flash-qspi-bulk` (full features over QSPI XIP, no flash-headroom limit);
  internal-flash alternative `cargo flash-sdmmc-bulk-prod` (~1.4 KB headroom). The
  CDC POS bridge (`/dev/ttyACM0`) is unaffected — it's a separate interface.

See `PI_KIOSK_BRINGUP.md` → "Audio source: localaudio vs live USB capture" and
`daisy/PLAN_USB_CAPTURE.md` for the why.
