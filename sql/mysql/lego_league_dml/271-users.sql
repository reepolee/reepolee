-- MySQL 8.0+ LEGO League seed data
-- Table: users

INSERT IGNORE INTO `users` (`id`, `username`, `email`, `name`, `nickname`, `avatar_image`, `verified_at`, `hashed_password`, `invitation_code`, `modules_tags`, `previous_hashed_password`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(1,'ales','ales@reepolee.com','Aleš Vaupotič','Aleš','/images/users/01a068cc-9064-769c-a05a-dc588449a580.webp','2026-08-31 16:22:00','$argon2id$v=19$m=65536,t=2,p=1$VGCXZXlhaduG/ryMf69Cb2xqzwWNIF+tbcOA3CRgcpg$I1qy++NgjjFc9HzTCVktMwCk/hIy7lVbNIyT3/5dvlQ','','user,system,admin,head-referee,referee,judge,mc,volunteer',NULL,'2026-08-31 10:22:34','2026-09-03 21:43:37',NULL,NULL);

INSERT IGNORE INTO `users` (`id`, `username`, `email`, `name`, `nickname`, `avatar_image`, `verified_at`, `hashed_password`, `invitation_code`, `modules_tags`, `previous_hashed_password`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(2,'natalija','natalija@reepolee.com','Natalija Premužič','Natalija','/images/01a068ca-85c0-723b-9a50-6321c79bcff9.webp','2026-08-31 16:22:00','$argon2id$v=19$m=65536,t=2,p=1$VGCXZXlhaduG/ryMf69Cb2xqzwWNIF+tbcOA3CRgcpg$I1qy++NgjjFc9HzTCVktMwCk/hIy7lVbNIyT3/5dvlQ','','user,admin,head-referee,referee,judge,mc,volunteer',NULL,'2026-08-31 10:22:34','2026-09-03 21:41:23',NULL,NULL);

INSERT IGNORE INTO `users` (`id`, `username`, `email`, `name`, `nickname`, `avatar_image`, `verified_at`, `hashed_password`, `invitation_code`, `modules_tags`, `previous_hashed_password`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(3,'aljosa','aljosa@reepolee.com','Aljoša Šip','Aljoša','','2026-08-31 16:22:00','$argon2id$v=19$m=65536,t=2,p=1$VGCXZXlhaduG/ryMf69Cb2xqzwWNIF+tbcOA3CRgcpg$I1qy++NgjjFc9HzTCVktMwCk/hIy7lVbNIyT3/5dvlQ','','user,admin,head-referee,referee,judge,mc,volunteer',NULL,'2026-08-31 10:22:34','2026-09-03 22:04:24',NULL,NULL);

INSERT IGNORE INTO `users` (`id`, `username`, `email`, `name`, `nickname`, `avatar_image`, `verified_at`, `hashed_password`, `invitation_code`, `modules_tags`, `previous_hashed_password`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(4,'ziga','ziga@reepolee.com','Žiga Sedmak','Žiga','','2026-08-31 16:22:00','$argon2id$v=19$m=65536,t=2,p=1$VGCXZXlhaduG/ryMf69Cb2xqzwWNIF+tbcOA3CRgcpg$I1qy++NgjjFc9HzTCVktMwCk/hIy7lVbNIyT3/5dvlQ','','mc,volunteer',NULL,'2026-08-31 10:22:34','2026-09-03 19:38:02',NULL,NULL);

INSERT IGNORE INTO `users` (`id`, `username`, `email`, `name`, `nickname`, `avatar_image`, `verified_at`, `hashed_password`, `invitation_code`, `modules_tags`, `previous_hashed_password`, `created_at`, `updated_at`, `archived_at`, `archived_by_user_id`) VALUES
(5,'jan','jan@reepolee.com','Jan Malej','Jan','','2026-08-31 16:22:00','$argon2id$v=19$m=65536,t=2,p=1$VGCXZXlhaduG/ryMf69Cb2xqzwWNIF+tbcOA3CRgcpg$I1qy++NgjjFc9HzTCVktMwCk/hIy7lVbNIyT3/5dvlQ','','head-referee,referee',NULL,'2026-08-31 10:22:34','2026-09-03 22:06:08',NULL,NULL);
