-- MySQL 8.0+ LEGO League seed data
-- Table: awards

INSERT INTO `awards` (`id`, `tournament_id`, `title`, `category_id`, `team_id`, `description`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(1,1,'Champion',NULL,1,'Awarded at the FLL Adria Finals.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(2,1,'Robot Performance Award',1,1,'Awarded at the FLL Adria Finals.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(3,1,'Robot Design Award',2,24,'Awarded at the FLL Adria Finals.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(4,1,'Innovation Project Award',3,17,'Awarded at the FLL Adria Finals.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(5,1,'Core Values Award',4,10,'Awarded at the FLL Adria Finals.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL);
