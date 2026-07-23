DROP TABLE IF EXISTS authors;

CREATE TABLE authors (
    id         INTEGER   PRIMARY KEY,
    name       TEXT      DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX authors_name ON authors(name);

CREATE TRIGGER authors_updated_at_trigger AFTER UPDATE ON authors FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE authors
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

INSERT INTO main.authors (id, name) VALUES
(1,'Aleš'),
(2,'Vishal'),
(3,'Evan'),
(4,'Jordan'),
(5,'Rich'),
(6,'Gal'),
(7,'Guillermo'),
(8,'Miško'),
(9,'Ryan'),
(10,'Adrian'),
(11,'David'),
(12,'Taylor'),
(13,'Nikolay'),
(14,'Manu'),
(15,'Phil'),
(16,'Jarred'),
(17,'Matteo'),
(18,'TJ'),
(19,'Sergio'),
(20,'Eric'),
(21,'Fred'),
(22,'Chris'),
(23,'Sebastián'),
(24,'Michael'),
(25,'Guillaume'),
(26,'Tom'),
(27,'Sébastien'),
(28,'Fenny'),
(29,'Steve'),
(30,'Fabien'),
(31,'Armin'),
(32,'Yehuda'),
(33,'Lucas');

DROP TABLE IF EXISTS languages;

CREATE TABLE languages (
    id         INTEGER   PRIMARY KEY,
    name       TEXT      DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX languages_name ON languages(name);

CREATE TRIGGER languages_updated_at_trigger AFTER UPDATE ON languages FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE languages
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

INSERT INTO main.languages (id, name) VALUES
(1,'Bun'),
(2,'Go'),
(3,'JavaScript'),
(4,'TypeScript'),
(5,'Python'),
(6,'Ruby'),
(7,'PHP'),
(8,'Rust'),
(9,'Java'),
(10,'Zig'),
(11,'Dart'),
(12,'Elixir'),
(13,'Scala'),
(14,'C#');

DROP TABLE IF EXISTS frameworks;

CREATE TABLE frameworks (
    id              INTEGER   PRIMARY KEY,
    name            TEXT      NOT NULL,
    tagline         TEXT      DEFAULT '',
    author_id       INTEGER   NOT NULL REFERENCES authors(id) ON UPDATE CASCADE,
    reviewer_id     INTEGER   NOT NULL REFERENCES authors(id) ON UPDATE CASCADE,
    language_id     INTEGER   NOT NULL REFERENCES languages(id) ON UPDATE CASCADE,
    first_commit_on DATE      NOT NULL,
    is_javascript   INTEGER   NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX frameworks_author_id ON frameworks(author_id);
CREATE INDEX frameworks_reviewer_id ON frameworks(reviewer_id);
CREATE INDEX frameworks_language_id ON frameworks(language_id);

CREATE UNIQUE INDEX frameworks_name_unique ON frameworks(name);

CREATE TRIGGER frameworks_updated_at_trigger AFTER UPDATE ON frameworks FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE frameworks
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;

INSERT INTO main.frameworks (id, name, tagline, author_id, reviewer_id, language_id, first_commit_on, is_javascript) VALUES
(1,'reepolee','Zero ceremony',1,6,1,'2026-03-01',1),
(2,'Echo','Web development for the rest of us',2,1,2,'2016-01-16',0),
(3,'Vue','The Progressive JavaScript Framework',3,1,3,'2013-07-15',1),
(4,'React','The library for web and native user interfaces',4,1,4,'2013-05-29',1),
(5,'Svelte','Web development for the rest of us',5,1,3,'2016-01-16',1),
(6,'Next.js','The React Framework for the Web',7,1,3,'2016-10-25',1),
(7,'Angular','The developer''s platform for building the web',8,1,4,'2014-09-18',1),
(8,'SolidJS','Simple and performant reactive web interfaces',9,6,4,'2018-04-24',1),
(9,'Django','The web framework for perfectionists with deadlines',10,1,5,'2005-07-16',0),
(10,'Rails','Compress the complexity of modern web apps',11,6,6,'2004-11-24',0),
(11,'Laravel','The PHP Framework for Web Artisans',12,1,7,'2011-06-09',0),
(12,'Actix','A powerful, pragmatic, and extremely fast actor framework',13,6,8,'2017-10-21',0),
(13,'Gin','Features a Martini-like API, but with performance up to 40 times faster',14,1,2,'2014-06-15',0),
(14,'Spring Boot','Takes an opinionated view of building production-ready applications',15,6,9,'2013-10-01',0),
(15,'Bun','Incredibly fast JavaScript runtime, bundler, test runner, and package manager',16,1,10,'2021-04-16',0),
(16,'Fastify','Fast and low overhead web framework, for Node.js',17,6,3,'2016-09-25',1),
(17,'Express','Fast, unopinionated, minimalist web framework for Node.js',18,1,3,'2009-06-26',1),
(18,'Rocket','An async web framework for Rust with a focus on usability',19,6,8,'2016-05-23',0),
(19,'Flutter','Google''s UI toolkit for building beautiful apps from a single codebase',20,1,11,'2014-10-23',0),
(20,'Astro','The web framework for content-driven websites',21,6,4,'2021-03-12',1),
(21,'Qwik','Deliver instant-on applications at any scale',8,1,4,'2020-10-16',1),
(22,'Phoenix','Productive. Reliable. Fast.',22,6,12,'2014-01-29',0),
(23,'FastAPI','Fast, high performance, easy to learn, fast to code, ready for production',23,1,5,'2018-12-04',0),
(24,'Remix','Build Better Websites. Focus on web standards and modern UX',24,6,4,'2020-10-02',1),
(25,'Play','The High Velocity Web Framework',25,1,13,'2007-04-12',0),
(26,'RedwoodJS','The App Framework for the Start-up Club',26,6,4,'2019-06-19',1),
(27,'Nuxt','The Intuitive Vue Framework',27,1,3,'2016-10-25',1),
(28,'Axum','Ergonomic and modular web framework in the Tokio ecosystem',11,6,8,'2021-07-30',0),
(29,'Fiber','An Express-inspired web framework written in Go',28,1,2,'2020-01-18',0),
(30,'Jekyll','Transform your plain text into static websites and blogs',26,6,6,'2008-10-19',0),
(31,'Hugo','The world''s fastest framework for building websites',29,1,2,'2013-07-04',0),
(32,'SvelteKit','Rapid development of robust, performant web applications',5,6,4,'2020-10-14',1),
(33,'Symfony','A set of reusable PHP components and a PHP framework',30,1,7,'2005-10-18',0),
(34,'ASP.NET Core','Cross-platform, high-performance, open-source framework',11,6,14,'2014-05-12',0),
(35,'Flask','A lightweight WSGI web application framework',31,1,5,'2010-04-06',0),
(36,'Ember.js','A framework for ambitious web developers',32,6,3,'2011-04-14',1),
(37,'Koa','Next generation web framework for Node.js',18,1,3,'2013-08-30',1),
(38,'Tauri','Build an optimized, secure, and robust application for a desktop or mobile OS',33,6,8,'2019-01-18',0);

DROP VIEW IF EXISTS v_frameworks;

CREATE VIEW v_frameworks AS
SELECT
    f.id,
    f.name,
    f.tagline,
    f.first_commit_on,
    f.is_javascript,
    f.author_id,
    f.language_id,
    f.reviewer_id,
    a.name  AS author_name,
    l.name  AS language_name,
    a2.name AS reviewer_name
FROM frameworks f
    LEFT JOIN authors a
        ON a.id = f.author_id
    LEFT JOIN authors a2
        ON a2.id = f.reviewer_id
    LEFT JOIN languages l
        ON l.id = f.language_id;
