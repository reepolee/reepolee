DROP TABLE IF EXISTS books;

CREATE TABLE books (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU',
    title        VARCHAR(255) NOT NULL COMMENT 'ICU',
    author       VARCHAR(255) NULL DEFAULT '' COMMENT 'ICU',
    isbn         VARCHAR(20)  NULL DEFAULT '' COMMENT 'ICU',
    published_on DATE         NULL DEFAULT NULL COMMENT '',
    is_in_stock  TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '',
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
) COMMENT '';

CREATE INDEX books_title ON books(title);

CREATE UNIQUE INDEX books_isbn_unique ON books(isbn);

INSERT IGNORE INTO books (title, author, isbn, published_on, is_in_stock) VALUES
('Pride and Prejudice','Jane Austen','978-0141439518','1813-01-28',1),
('Dune','Frank Herbert','978-0441172719','1965-08-01',1),
('The Left Hand of Darkness','Ursula K. Le Guin','978-0441478125','1969-03-01',0);
