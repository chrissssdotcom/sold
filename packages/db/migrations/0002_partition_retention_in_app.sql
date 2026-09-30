-- Partition retention moves out of SQL and into the application (`maintainOutboxPartitions`).
--
-- `sold_drop_old_partitions` ran `DROP TABLE` on a partition from inside a function with no bound on how long it
-- waited for the ACCESS EXCLUSIVE lock on the PARENT. Every checkout insert into outbox_events queues behind a
-- waiting lock request, so a slow drop stalls the order path (measured ~1 s, capped only by lock_timeout).
-- The job now drops with a very short lock_timeout and retries, so writers stall for at most that timeout.

-- sold:allow destructive: superseded by app-side retention with a bounded lock wait; nothing else calls this function
DROP FUNCTION IF EXISTS sold_drop_old_partitions(regclass, integer);
