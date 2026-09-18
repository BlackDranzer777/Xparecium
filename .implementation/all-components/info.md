# Aparecium, in plain English

**Reveal how your system works.**

Aparecium is a practice space for designing the computers behind an app. Draw
people using the app, an application server, a database and optionally a cache
(a place to keep frequently requested answers). Connect them, choose how busy
the app is, and press Run.

It is for learners, teachers and developers who want to understand where a
system slows down and what changing one part might do.

## What you can do today

- Start with a ready-to-run example or an empty drawing.
- Build from fifteen kinds of piece: **Users** (the people using it); at the
  edge a **DNS** (turns your name into an address), a **CDN** (answers most
  requests before they reach you), a **WAF** (turns bad requests away) and an
  **API Gateway** (the front door, with a rate limit); then a **Load Balancer**
  (shares the work across several machines), an **Application Server** (your
  code on a machine you keep) or a **Serverless Function** (your code with no
  machine to keep); a **Database**, a **Read Replica** (a copy that answers
  reads), a **Cache**, a **Key-Value Store** (records by key, any scale) and
  **Object Storage** (files); a **Message Queue** (work done later by one
  worker) and a **Pub/Sub Topic** (one event, many listeners).
- Change traffic, machine capacity, database speed, cache hit rate and connections.
- See completed requests, waiting times, busy resources, rejected requests and
  a few sample request journeys.
- Choose **Live** and press **Run simulation**. Requests keep arriving and the
  counts keep changing until you press **Stop simulation**.
- Choose **Timed** for a fixed-duration experiment. Completed runs stop moving.
- **Keep** saves the numbers you see for comparison. Export includes the latest
  snapshot too. A saved snapshot never starts running just because you open it.
- **<1%** means the component did some work but used less than 1% of its capacity.
- Change one setting, run again, and compare both the inputs and the results.
- Create, rename, open and delete projects. Export and import backups.

For example, run the starter design, increase the number of users, and run it
again. Watch for longer queues or rejected requests. Then increase the server's
computing capacity and compare. That experiment shows whether the server was
limiting this particular design.

## What the numbers mean

These are estimates from a simplified model, not measurements of real machines.
The model represents computing work, limited capacity, waiting queues and
network transfer. It does not reproduce a real database, operating system or
individual user sessions. Cache and CDN hit rates, the share a WAF blocks and
the share of requests that need a DNS lookup are assumptions you set. A load
balancer shares work out by the rule you choose and nothing else: no health
checks, no retries, no sticky sessions.

Cost estimates use rates read from the providers' own published price lists
where those are open (AWS, Azure), each marked with the date it was checked,
and clearly labelled illustrative rates where they are not (Google Cloud).
The monthly estimate assumes the measured traffic continues for the whole month.
It excludes several real-world charges; it is not a provider quote.
Missing rates appear as **unpriced**; a partial estimate is not a complete
bill.

## Saving your work

Projects are saved automatically in this browser. Switching projects saves
pending edits first. If a save fails, the current work stays open so you can
export it. Results from an earlier configuration are marked accordingly.

Use **Projects, import and export → Export JSON** to keep a backup or move work
to another browser or device. Import creates a separate project and separate
copies of its saved runs. Clearing browser data can remove local projects.

Everything runs in your browser. There is no account, application backend or
cloud sync, and Aparecium never creates real cloud resources. The supported components are listed above. Unsupported routes are explained before
running. The interface is designed primarily for desktop screens.

See [README.md](README.md) for startup instructions and [future.md](future.md)
for features that have not been built yet.

## Staged expansion

Work is isolated in `.implementation/all-components`; the working application has not yet been replaced. A local source checkpoint and baseline hashes protect the previous version. The initial five stores introduce indexed/scanned documents, partition contention, delayed search visibility, warehouse scan volume and time-series retention. The remaining eleven components are listed in implementation-plan.md. New costs are explicitly unpriced until a suitable rate is entered; no new provider prices have been verified.

Stage A verification: five data stores pass their integration checks in the staged copy (entry 060). Stage B has begun; the main app is still unchanged.


Expansion progress (2026-09-13): Staged additions: event streams retain history; dead-letter queues hold jobs that exhausted retries; schedulers start jobs at a chosen interval. Retry/replay/retention controls are explicit. No calendar cron parser or durable external broker is launched.
