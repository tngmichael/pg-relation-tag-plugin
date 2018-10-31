set client_min_messages = 'error';
drop schema if exists p cascade;
create schema p;

create table p.user (
  id            serial primary key,
  username      text,
  email         text,
  name          text,
  about         text,
  created_at    timestamp not null default now(),
  unique(username, email)
);

create table p.post (
  id            serial primary key,
  headline      text,
  body          text,
  user_id       int,
  reviewed_by   int,
  published_by  text,
  email_to      text
);

comment on column p.post.user_id is
  E'@references p.user(id)';
comment on table p.post is
  E'@foreignKey (reviewed_by) references p.user(id)\n@foreignKey (published_by, email_to) references p.user(username, email)';