insert into p.user (
  username,
  email,
  name,
  about
) values
  ('michael', 'fake@mail.com', 'Michael', 'Just a web developer');

insert into p.post (
  headline,
  body,
  user_id,
  reviewed_by,
  published_by,
  email_to
) values
  (
    'Learning Postgraphile',
    'Best way to learn postgraphile is using it',
    1, 1, 'michael', 'fake@mail.com'
  );