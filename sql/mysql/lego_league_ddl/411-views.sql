-- MySQL 8.0+ LEGO League schema
-- Combined multi-table views

CREATE VIEW v_awards AS
SELECT
    a.id,
    a.display,
    a.tournament_id,
    a.title,
    a.category_id,
    a.team_id,
    a.archived_at,
    a.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display  AS tournament_display,
    c.display  AS category_display,
    tm.display AS team_display
FROM awards a
    LEFT JOIN tournaments t
        ON t.id = a.tournament_id
    LEFT JOIN categories c
        ON c.id = a.category_id
    LEFT JOIN teams tm
        ON tm.id = a.team_id
    LEFT JOIN users u
        ON u.id = a.archived_by_user_id;

DROP VIEW IF EXISTS `v_emails`;

CREATE VIEW v_emails AS
SELECT
    e.id,
    e.display,
    e.team_id,
    e.tournament_id,
    e.recipient,
    e.subject,
    e.type,
    e.status_id,
    e.sent_at,
    e.archived_at,
    e.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    tm.display AS team_display,
    t.display  AS tournament_display,
    es.display AS status_display
FROM emails e
    LEFT JOIN teams tm
        ON tm.id = e.team_id
    LEFT JOIN tournaments t
        ON t.id = e.tournament_id
    LEFT JOIN email_statuses es
        ON es.id = e.status_id
    LEFT JOIN users u
        ON u.id = e.archived_by_user_id;

DROP VIEW IF EXISTS `v_feature_flags`;

CREATE VIEW v_feature_flags AS
SELECT
    f.id,
    f.display,
    f.name,
    f.is_enabled,
    f.rollout_pct,
    f.description,
    f.archived_at,
    f.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    f.created_at,
    f.updated_at,
    CONCAT(f.name, '__', f.description) AS search_text
FROM feature_flags f
    LEFT JOIN users u
        ON u.id = f.archived_by_user_id;

DROP VIEW IF EXISTS `v_files`;

CREATE VIEW v_files AS
SELECT
    f.id,
    f.display,
    f.folder,
    f.filename,
    f.s3_key,
    f.original_filename,
    f.title,
    f.description,
    f.tags,
    f.mime_type,
    f.file_type,
    f.file_size,
    f.uploaded_by_user_id,
    f.archived_at,
    f.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    f.created_at,
    f.updated_at,
    CONCAT(f.folder, '__', f.filename, '__', f.s3_key, '__', COALESCE(f.original_filename, ''), '__', COALESCE(f.title, ''), '__', COALESCE(f.description, ''), '__', COALESCE(f.tags, ''), '__', f.mime_type) AS search_text
FROM files f
    LEFT JOIN users u
        ON u.id = f.archived_by_user_id;

DROP VIEW IF EXISTS `v_games`;

CREATE VIEW v_games AS
SELECT
    g.id,
    g.display,
    g.tournament_id,
    g.team_id,
    g.round_number,
    g.referee_id,
    g.table_id,
    g.points,
    g.gp,
    g.is_acknowledged,
    g.archived_at,
    g.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display  AS tournament_display,
    tm.display AS team_display,
    v.display  AS referee_display,
    a.display  AS table_display
FROM games g
    LEFT JOIN tournaments t
        ON t.id = g.tournament_id
    LEFT JOIN teams tm
        ON tm.id = g.team_id
    LEFT JOIN volunteers v
        ON v.id = g.referee_id
    LEFT JOIN arena_tables a
        ON a.id = g.table_id
    LEFT JOIN users u
        ON u.id = g.archived_by_user_id;

DROP VIEW IF EXISTS `v_images`;

CREATE VIEW v_images AS
SELECT
    i.id,
    i.display,
    i.folder,
    i.filename,
    i.s3_key,
    i.original_filename,
    i.title,
    i.description,
    i.tags,
    i.mime_type,
    i.width,
    i.height,
    i.file_size,
    i.archived_at,
    i.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    i.created_at,
    i.updated_at,
    CONCAT(i.folder, '__', i.filename, '__', i.s3_key, '__', COALESCE(i.original_filename, ''), '__', COALESCE(i.title, ''), '__', COALESCE(i.description, ''), '__', COALESCE(i.tags, ''), '__', i.mime_type) AS search_text
FROM images i
    LEFT JOIN users u
        ON u.id = i.archived_by_user_id;

DROP VIEW IF EXISTS `v_judging_pivot`;

CREATE VIEW v_judging_pivot AS
SELECT
    p.tournament_id,
    p.team_id,
    t.display,
    t.title,
    MAX(CASE WHEN c.code = 'cv' THEN p.points END) AS cv_points,
    MAX(CASE WHEN c.code = 'cv' THEN p.`rank` END) AS cv_rank,
    MAX(CASE WHEN c.code = 'pr' THEN p.points END) AS pr_points,
    MAX(CASE WHEN c.code = 'pr' THEN p.`rank` END) AS pr_rank,
    MAX(CASE WHEN c.code = 'rd' THEN p.points END) AS rd_points,
    MAX(CASE WHEN c.code = 'rd' THEN p.`rank` END) AS rd_rank,
    MAX(CASE WHEN c.code = 'rg' THEN p.points END) AS rg_points,
    MAX(CASE WHEN c.code = 'rg' THEN p.`rank` END) AS rg_rank
FROM points p
    LEFT JOIN teams t
        ON t.id = p.team_id
    LEFT JOIN categories c
        ON c.id = p.category_id
GROUP BY p.tournament_id, p.team_id
ORDER BY p.tournament_id ASC, p.team_id ASC;

DROP VIEW IF EXISTS `v_latest_scores`;

CREATE VIEW v_latest_scores AS
SELECT
    g.id,
    t.display,
    g.tournament_id,
    g.team_id,
    g.round_number,
    g.points,
    g.gp,
    g.is_acknowledged,
    g.created_at,
    TIMESTAMPDIFF(MINUTE, g.created_at, CURRENT_TIMESTAMP) AS entry_before
FROM games g
    LEFT JOIN teams t
        ON t.id = g.team_id
ORDER BY g.created_at DESC;

DROP VIEW IF EXISTS `v_match_schedule`;

CREATE VIEW v_match_schedule AS
SELECT
    ms.id,
    CONCAT(ms.start_time, ' - ', COALESCE(t1.display, ''), ' - ', COALESCE(t2.display, '')) AS display,
    ms.tournament_id,
    t.display  AS tournament_display,
    ms.round_number,
    ms.start_time,
    ms.table_1_id,
    ms.table_2_id,
    ms.team_1_id,
    ms.team_2_id,
    a1.display AS table_1_display,
    a2.display AS table_2_display,
    t1.display AS team_1_display,
    t1.school  AS team_1_school,
    t2.display AS team_2_display,
    t2.school  AS team_2_school
FROM match_slots ms
    LEFT JOIN tournaments t
        ON t.id = ms.tournament_id
    LEFT JOIN arena_tables a1
        ON a1.id = ms.table_1_id
    LEFT JOIN arena_tables a2
        ON a2.id = ms.table_2_id
    LEFT JOIN teams t1
        ON t1.id = ms.team_1_id
    LEFT JOIN teams t2
        ON t2.id = ms.team_2_id
ORDER BY ms.start_time ASC, ms.round_number ASC;

DROP VIEW IF EXISTS `v_match_slots`;

CREATE VIEW v_match_slots AS
SELECT
    ms.id,
    ms.display,
    ms.tournament_id,
    ms.round_number,
    ms.start_time,
    ms.table_1_id,
    ms.table_2_id,
    ms.team_1_id,
    ms.team_2_id,
    ms.archived_at,
    ms.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display   AS tournament_display,
    a1.display  AS table_1_display,
    a2.display  AS table_2_display,
    tm1.display AS team_1_display,
    tm2.display AS team_2_display
FROM match_slots ms
    LEFT JOIN tournaments t
        ON t.id = ms.tournament_id
    LEFT JOIN arena_tables a1
        ON a1.id = ms.table_1_id
    LEFT JOIN arena_tables a2
        ON a2.id = ms.table_2_id
    LEFT JOIN teams tm1
        ON tm1.id = ms.team_1_id
    LEFT JOIN teams tm2
        ON tm2.id = ms.team_2_id
    LEFT JOIN users u
        ON u.id = ms.archived_by_user_id;

DROP VIEW IF EXISTS `v_points`;

CREATE VIEW v_points AS
SELECT
    p.id,
    p.display,
    p.tournament_id,
    p.team_id,
    p.category_id,
    p.judge_id,
    p.`rank`,
    p.points,
    p.archived_at,
    p.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display  AS tournament_display,
    tm.display AS team_display,
    c.display  AS category_display,
    v.display  AS judge_display
FROM points p
    LEFT JOIN tournaments t
        ON t.id = p.tournament_id
    LEFT JOIN teams tm
        ON tm.id = p.team_id
    LEFT JOIN categories c
        ON c.id = p.category_id
    LEFT JOIN volunteers v
        ON v.id = p.judge_id
    LEFT JOIN users u
        ON u.id = p.archived_by_user_id;

DROP VIEW IF EXISTS `v_rankings`;

CREATE VIEW v_rankings AS WITH display_data AS(SELECT tournament_id, team_id, MAX(CASE WHEN round_number = 0 THEN points END) AS r0_points, MAX(CASE WHEN round_number = 1 THEN points END) AS r1_points, MAX(CASE WHEN round_number = 2 THEN points END) AS r2_points, MAX(CASE WHEN round_number = 3 THEN points END) AS r3_points, MAX(CASE WHEN round_number = 4 THEN points END) AS r4_points, MAX(CASE WHEN round_number = 0 THEN gp END) AS gp0, MAX(CASE WHEN round_number = 1 THEN gp END) AS gp1, MAX(CASE WHEN round_number = 2 THEN gp END) AS gp2, MAX(CASE WHEN round_number = 3 THEN gp END) AS gp3, MAX(CASE WHEN round_number = 4 THEN gp END) AS gp4 FROM games GROUP BY tournament_id, team_id), sorted_scores AS(SELECT tournament_id, team_id, points, ROW_NUMBER() OVER(PARTITION BY tournament_id, team_id ORDER BY points DESC) AS rank_idx FROM games WHERE round_number != 0), ranking_logic AS(SELECT tournament_id, team_id, MAX(CASE WHEN rank_idx = 1 THEN points ELSE 0 END) AS best, MAX(CASE WHEN rank_idx = 2 THEN points ELSE 0 END) AS SECOND, MAX(CASE WHEN rank_idx = 3 THEN points ELSE 0 END) AS third, MAX(CASE WHEN rank_idx = 4 THEN points ELSE 0 END) AS fourth FROM sorted_scores GROUP BY tournament_id, team_id)
SELECT
    RANK() OVER(PARTITION BY d.tournament_id ORDER BY COALESCE(l.best, 0) DESC, COALESCE(l.SECOND, 0) DESC, COALESCE(l.third, 0) DESC, COALESCE(l.fourth, 0) DESC) AS ranking,
    t.id,
    t.display,
    t.title,
    t.school,
    d.tournament_id,
    d.r0_points,
    d.r1_points,
    d.r2_points,
    d.r3_points,
    d.r4_points,
    d.gp0,
    d.gp1,
    d.gp2,
    d.gp3,
    d.gp4,
    l.best,
    l.second,
    l.third,
    l.fourth
FROM teams t
    LEFT JOIN display_data d
        ON d.team_id = t.id
    LEFT JOIN ranking_logic l
        ON l.team_id = t.id
ORDER BY d.tournament_id ASC, ranking ASC, t.id ASC;

DROP VIEW IF EXISTS `v_results`;

CREATE VIEW v_results AS
SELECT
    p.tournament_id,
    p.team_id,
    t.display,
    t.title,
    SUM(p.points) AS total_points,
    AVG(p.points) AS mean,
    ROUND(SQRT(AVG(p.points * p.points) - AVG(p.points)* AVG(p.points)), 3) AS std_deviation
FROM points p
    LEFT JOIN teams t
        ON t.id = p.team_id
WHERE p.`rank` IS NOT NULL AND p.points IS NOT NULL
GROUP BY p.tournament_id, p.team_id
ORDER BY p.tournament_id ASC, total_points DESC, std_deviation ASC;

DROP VIEW IF EXISTS `v_schedule_items`;

CREATE VIEW v_schedule_items AS
SELECT
    si.id,
    si.display,
    si.tournament_id,
    si.title,
    si.start_time,
    si.archived_at,
    si.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display AS tournament_display
FROM schedule_items si
    LEFT JOIN tournaments t
        ON t.id = si.tournament_id
    LEFT JOIN users u
        ON u.id = si.archived_by_user_id;

DROP VIEW IF EXISTS `v_seasons`;

CREATE VIEW v_seasons AS
SELECT
    s.id,
    s.display,
    s.title,
    s.status_id,
    s.starts_on,
    s.ends_on,
    s.archived_at,
    s.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    ss.display AS status_display
FROM seasons s
    LEFT JOIN season_statuses ss
        ON ss.id = s.status_id
    LEFT JOIN users u
        ON u.id = s.archived_by_user_id;

DROP VIEW IF EXISTS `v_table_counts`;

CREATE VIEW v_table_counts AS
SELECT
    CAST('images' AS CHAR) AS display,
    'images'         AS table_name,
    '/system/images' AS route,
    COUNT(*) AS record_count
FROM images
WHERE archived_at IS NULL
UNION ALL
SELECT
    'files',
    'files',
    '/system/files',
    COUNT(*)
FROM files
WHERE archived_at IS NULL
UNION ALL
SELECT
    'modules',
    'modules',
    NULL,
    COUNT(*)
FROM modules
WHERE archived_at IS NULL
UNION ALL
SELECT
    'users',
    'users',
    '/system/users',
    COUNT(*)
FROM users
WHERE archived_at IS NULL;

DROP VIEW IF EXISTS `v_team_members`;

CREATE VIEW v_team_members AS
SELECT
    tm.id,
    tm.display,
    tm.team_id,
    tm.first_name,
    tm.last_name,
    tm.birth_year,
    tm.archived_at,
    tm.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display AS team_display
FROM team_members tm
    LEFT JOIN teams t
        ON t.id = tm.team_id
    LEFT JOIN users u
        ON u.id = tm.archived_by_user_id;

DROP VIEW IF EXISTS `v_teams`;

CREATE VIEW v_teams AS
SELECT
    t.id,
    t.display,
    t.title,
    t.school,
    t.country_code,
    t.season_id,
    t.status_id,
    t.is_paid,
    t.paid_on,
    t.archived_at,
    t.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    s.display  AS season_display,
    ts.display AS status_display
FROM teams t
    LEFT JOIN seasons s
        ON s.id = t.season_id
    LEFT JOIN team_statuses ts
        ON ts.id = t.status_id
    LEFT JOIN users u
        ON u.id = t.archived_by_user_id;

DROP VIEW IF EXISTS `v_tournament_teams`;

CREATE VIEW v_tournament_teams AS
SELECT
    tt.id,
    tt.display,
    tt.tournament_id,
    tt.team_id,
    tt.is_present,
    tt.checked_in_at,
    tt.archived_at,
    tt.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display  AS tournament_display,
    tm.display AS team_display
FROM tournament_teams tt
    LEFT JOIN tournaments t
        ON t.id = tt.tournament_id
    LEFT JOIN teams tm
        ON tm.id = tt.team_id
    LEFT JOIN users u
        ON u.id = tt.archived_by_user_id;

DROP VIEW IF EXISTS `v_tournament_volunteers`;

CREATE VIEW v_tournament_volunteers AS
SELECT
    tv.id,
    tv.display,
    tv.tournament_id,
    tv.volunteer_id,
    tv.role_id,
    tv.archived_at,
    tv.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    t.display AS tournament_display,
    v.display AS volunteer_display,
    r.display AS role_display
FROM tournament_volunteers tv
    LEFT JOIN tournaments t
        ON t.id = tv.tournament_id
    LEFT JOIN volunteers v
        ON v.id = tv.volunteer_id
    LEFT JOIN roles r
        ON r.id = tv.role_id
    LEFT JOIN users u
        ON u.id = tv.archived_by_user_id;

DROP VIEW IF EXISTS `v_tournaments`;

CREATE VIEW v_tournaments AS
SELECT
    t.id,
    t.display,
    t.title,
    t.location,
    t.season_id,
    t.tournament_type_id,
    t.status_id,
    t.starts_on,
    t.ends_on,
    t.rounds,
    t.has_test_round,
    t.current_round,
    t.teams_advancing,
    t.teams_waiting,
    t.head_referee_id,
    t.archived_at,
    t.archived_by_user_id,
    COALESCE(u.email, u.username) AS archived_by_user_display,
    s.display  AS season_display,
    tt.display AS tournament_type_display,
    ts.display AS status_display,
    v.display  AS head_referee_display
FROM tournaments t
    LEFT JOIN seasons s
        ON s.id = t.season_id
    LEFT JOIN tournament_types tt
        ON tt.id = t.tournament_type_id
    LEFT JOIN tournament_statuses ts
        ON ts.id = t.status_id
    LEFT JOIN volunteers v
        ON v.id = t.head_referee_id
    LEFT JOIN users u
        ON u.id = t.archived_by_user_id;
