# This project is discontinued — fork it

I've stopped working on Apex. The code stays up under the [MIT license](LICENSE). **Please fork it and do whatever
you want with it** — no permission needed, no credit required (though it's nice).

## Why

The whole project rests on Formula 1's timing data, read through [FastF1](https://github.com/theOehrly/Fast-F1).
In mid-October 2026 Formula 1 started requiring authentication for its timing archive
(`livetiming.formula1.com/static/…` now answers `401` to anonymous requests; see
[FastF1 #978](https://github.com/theOehrly/Fast-F1/issues/978)). In practice:

* New races can no longer be generated anonymously. FastF1 3.9+ needs an F1 TV subscription token, which is
  unreliable from cloud machines and subject to F1 TV's terms.
* FastF1's maintainers have said they won't rehost the data, so there is no free mirror to fall back on.
* Without a free, open data source I can't offer "open any race" for everyone, and I don't want to build a project on
  access that can be withdrawn again.

So rather than let it rot half-working, I'm calling it done. Everything that was generated before the change still works.

## What's here

A complete pipeline (FastF1 + OpenStreetMap + terrain → race and circuit files), a Cloudflare Worker, and a
React Three Fiber renderer with an automatic race director. Start with the [README](README.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Ideas if you pick it up

* **A new data source.** [OpenF1](https://openf1.org/) serves 2023+ sessions (positions, car data, laps, stints, race
  control, weather) with no login. Its free tier is labelled personal use under CC BY-NC-SA 4.0, so read their terms
  before hosting anything publicly. The only place that touches FastF1 is `pipeline/f1sim/ingest/fastf1_source.py`.
* **FastF1 with your own login.** Races already in your FastF1 cache still generate offline; new ones need FastF1 ≥ 3.9
  and an authenticated session. Check the F1 TV terms first.
* **Just the renderer.** It only needs the generated files; `VITE_DATA_BASE` points it at any location.

## Please respect

* Formula 1's data and trademarks are not mine and not covered by the MIT license; read [`NOTICE.md`](NOTICE.md).
* Don't republish raw F1 data.

The hosted demo only contains races generated before the change and may disappear without notice.
Takedown or rights questions: **shadster.dev@gmail.com**.
