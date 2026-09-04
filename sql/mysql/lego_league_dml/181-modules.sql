-- MySQL 8.0+ LEGO League seed data
-- Table: modules
INSERT IGNORE INTO `modules` (`id`, `code`, `name`, `description`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(1,'default','Default','Public visitor','2026-08-31 08:22:31','2026-09-03 17:30:33',NULL,NULL),
(2,'user','User','User','2026-08-31 08:22:31','2026-09-03 17:30:21',NULL,NULL),
(3,'system','System Administration','System Administration','2026-08-31 08:22:31','2026-09-03 17:30:17',NULL,NULL),
(4,'admin','Administration','Tournament organization','2026-08-31 08:22:31','2026-09-03 17:30:14',NULL,NULL),
(6,'head-referee','Head Referees','Head Referees','2026-09-03 17:21:07','2026-09-03 17:28:58',NULL,NULL),
(7,'referee','Referees','Acces to arena data','2026-09-03 17:18:12','2026-09-03 17:29:01',NULL,NULL),
(8,'judge','Judges','Access to judging data','2026-09-03 17:18:38','2026-09-03 17:29:03',NULL,NULL),
(9,'mc','Master of Ceremony','Official Announcer','2026-09-03 17:19:08','2026-09-03 17:29:04',NULL,NULL),
(10,'volunteer','Volunteers','Volunteers','2026-09-03 17:21:07','2026-09-03 17:29:49',NULL,NULL),
(101,'examples','Examples','Examples','2026-08-31 08:22:31','2026-09-03 17:30:55',NULL,NULL);
