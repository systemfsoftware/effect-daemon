---
"@systemfsoftware/effect-daemon-cluster": minor
---

Run singletons across processes over Postgres. `ClusterMedium.sqlRunnerLayer` builds `Sharding` over `SqlRunnerStorage` with no-op runner transport, health and message storage, from a caller's `SqlClient` and `ClusterMedium.SqlRunnerSettings`. The oldest live runner owns every shard, so a joining process waits as a standby, and a runner whose sessions are gone leaves at the next assignment poll. The layer fails with `RunnerSessionsUnnamed` unless the client's sessions carry the runner address as `application_name`.

A singleton whose shard another runner owns is now announced ready at once instead of never, and a run interrupted because its shard moved away keeps the child registered instead of reporting it terminated. Stopping a child with no run in flight reports `Shutdown`.
