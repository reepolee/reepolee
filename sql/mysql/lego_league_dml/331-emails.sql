-- MySQL 8.0+ LEGO League seed data
-- Table: emails

INSERT INTO `emails` (`id`, `team_id`, `tournament_id`, `recipient`, `subject`, `body`, `type`, `status_id`, `sent_at`, `provider_message_id`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(1,1,1,'glitch404.coach@example.com','FLL Adria Finals - results','Your team ranked 1st at the finals. Congratulations!','results',2,'2026-08-21 10:08:38','demo-smtp-0001','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(2,2,1,'ajeto.coach@example.com','Schedule change - round 2','Round 2 of the robot game moves to 10:50.','schedule_change',1,NULL,NULL,'2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(3,NULL,NULL,'all-coaches@example.com','Welcome to season UNEARTHED','Registration for the 2025/26 season is open.','season_announcement',2,'2025-09-01 09:00:00','demo-smtp-0002','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL);
