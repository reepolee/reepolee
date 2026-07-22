DROP TABLE IF EXISTS ingredients;
DROP TABLE IF EXISTS recipes;

CREATE TABLE recipes (
    id           INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
    name         TEXT     NOT NULL DEFAULT '',
    servings     INTEGER  NOT NULL DEFAULT 0,
    instructions TEXT     NOT NULL DEFAULT '',
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT NULL
);

CREATE INDEX recipes_name ON recipes(name);

CREATE TRIGGER recipes_update_timestamp AFTER UPDATE ON recipes FOR EACH ROW BEGIN UPDATE recipes SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

INSERT INTO recipes (id, name, servings, instructions) VALUES
(1,'Pizza',4,'Spread the dough with tomato sauce, top with mozzarella and basil, drizzle with olive oil, and bake until golden.'),
(2,'Pasta',4,'Cook the spaghetti, fry the guanciale, then toss off the heat with egg yolks and pecorino to form a creamy sauce. Finish with black pepper.'),
(3,'Wienerschnitzel',2,'Pound the veal cutlets thin, coat in flour, egg, then breadcrumbs, and fry in butter until golden. Serve with a squeeze of lemon.'),
(4,'Fried Rice',4,'Scramble the eggs, then stir-fry with cooked rice, spring onion, peas and carrots. Season with soy sauce and finish with sesame oil.'),
(5,'Cheesecake',8,'Mix crushed digestive biscuits with melted butter for the crust. Beat cream cheese, sugar, eggs, and vanilla, pour over the crust, and bake.');

CREATE TABLE ingredients (
    id         INTEGER  NOT NULL PRIMARY KEY AUTOINCREMENT,
    name       TEXT     NOT NULL DEFAULT '',
    quantity   REAL     NOT NULL DEFAULT 0,
    unit       TEXT     NOT NULL DEFAULT '',
    recipe_id  INTEGER  NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT NULL,
    FOREIGN KEY(recipe_id) REFERENCES recipes(id) ON UPDATE CASCADE
);

CREATE INDEX ingredients_name ON ingredients(name);
CREATE INDEX ingredients_recipe_id ON ingredients(recipe_id);

CREATE TRIGGER ingredients_update_timestamp AFTER UPDATE ON ingredients FOR EACH ROW BEGIN UPDATE ingredients SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;

END;

INSERT INTO ingredients (id, name, quantity, unit, recipe_id) VALUES
(1,'Pizza dough',1,'ball',1),
(2,'Tomato sauce',120,'g',1),
(3,'Mozzarella',200,'g',1),
(4,'Fresh basil',10,'leaves',1),
(5,'Olive oil',15,'ml',1),
(6,'Spaghetti',400,'g',2),
(7,'Guanciale',150,'g',2),
(8,'Egg yolks',4,'pcs',2),
(9,'Pecorino Romano',100,'g',2),
(10,'Black pepper',5,'g',2),
(11,'Veal cutlets',2,'pcs',3),
(12,'Flour',100,'g',3),
(13,'Eggs',2,'pcs',3),
(14,'Breadcrumbs',150,'g',3),
(15,'Butter',50,'g',3),
(16,'Lemon',1,'pcs',3),
(17,'Cooked rice',600,'g',4),
(18,'Eggs',2,'pcs',4),
(19,'Spring onion',30,'g',4),
(20,'Soy sauce',30,'ml',4),
(21,'Frozen peas and carrots',150,'g',4),
(22,'Sesame oil',10,'ml',4),
(23,'Cream cheese',900,'g',5),
(24,'Digestive biscuits',250,'g',5),
(25,'Butter',100,'g',5),
(26,'Sugar',200,'g',5),
(27,'Eggs',3,'pcs',5),
(28,'Vanilla extract',10,'ml',5);
