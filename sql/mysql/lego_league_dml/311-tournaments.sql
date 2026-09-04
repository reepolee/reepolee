-- MySQL 8.0+ LEGO League seed data
-- Table: tournaments

INSERT INTO `tournaments` (`id`, `season_id`, `tournament_type_id`, `status_id`, `title`, `location`, `starts_on`, `ends_on`, `rounds`, `has_test_round`, `current_round`, `teams_advancing`, `teams_waiting`, `head_referee_id`, `description`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(1,1,3,3,'FLL Adria Finals','OŠ Dobrova, Dobrova','2026-03-14',NULL,3,1,3,6,3,1,'Finals of the UNEARTHED season.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL),
(2,1,1,1,'FLL Adria Regional','OŠ Ormož, Ormož','2026-02-07',NULL,3,0,1,6,0,1,'Regional qualifier for the finals.','2026-08-21 10:08:38','2026-08-21 10:08:38',NULL,NULL);
