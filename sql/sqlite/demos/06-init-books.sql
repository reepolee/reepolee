DROP TABLE IF EXISTS books;

CREATE TABLE books (
    id           INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
    title        TEXT     NOT NULL,
    author       TEXT     DEFAULT '' NULL,
    isbn         TEXT     DEFAULT '' NULL,
    published_on DATE     DEFAULT NULL,
    is_in_stock  INTEGER  DEFAULT 1,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT NULL
);

CREATE INDEX books_title ON books(title);

CREATE UNIQUE INDEX books_isbn_unique ON books(isbn);

CREATE TRIGGER books_update_timestamp AFTER UPDATE ON books FOR EACH ROW BEGIN UPDATE books SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

INSERT INTO books (title, author, isbn, published_on, is_in_stock) VALUES
('Pride and Prejudice','Jane Austen','978-0141439518','1813-01-28',1),
('Dune','Frank Herbert','978-0441172719','1965-08-01',1),
('The Left Hand of Darkness','Ursula K. Le Guin','978-0441478125','1969-03-01',0);
