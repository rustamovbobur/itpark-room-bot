-- Initial colors are unique; employees may deliberately select the same custom color.
CREATE TABLE user_colors (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  initial_color TEXT NOT NULL UNIQUE CHECK(length(initial_color)=7 AND substr(initial_color,1,1)='#' AND substr(initial_color,2) NOT GLOB '*[^0-9a-f]*'),
  custom_color TEXT CHECK(custom_color IS NULL OR (length(custom_color)=7 AND substr(custom_color,1,1)='#' AND substr(custom_color,2) NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX user_colors_custom ON user_colors(custom_color);
