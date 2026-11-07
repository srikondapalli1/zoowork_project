# Demo recordings

| File | What it is |
|---|---|
| `qr-room-demo.mp4` | **Live** run of the room (QR) flow on ZooWork Managed Agents: seller console, big screen and a buyer's phone, 2.5 minutes, 1080p. Banner reads "LIVE on ZooWork Managed Agents". |
| `qr-room-demo-final.png` | The last frame of that run (winner and stats card). |
| `qr-stub-rehearsal.mp4` | Free rehearsal with local stand-ins. Banner reads "STUB RUN". Not proof of the platform. |
| `stub-rehearsal.mp4` | The marketplace layout rehearsal, local stand-ins and a local browser. Banner reads "STUB RUN". |

## Result of the live room run (20:29 to 20:32 on 2026-11-07)

- The real Lister researched the photo (image tool, ZooData, two web searches) and its comparables were priced by the relay with outliers excluded.
- 46 turns were answered by the live Negotiator, 1 got the template fallback at the 8-second deadline, and 14 stale turns were interrupted.
- The attack bot passed **17 of 18** checks. The failing one, "Spammer: only the accepted offer created a session event" (events 6 to 8, expected +1),
  was a recorder artifact: the on-camera buyer posted its own offer inside the bot's quiet-window measurement. The other two isolation checks
  passed (schema attacker 6 to 6, outliers 8 to 8). The recorder now holds the on-camera buyer until the bot's probes finish;
  the stub rehearsal passes 18 of 18 with that fix. The live run was not repeated after the fix.
