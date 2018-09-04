set client_min_messages = 'error';
drop schema if exists p cascade;
create schema p;

create table p.user (
  id serial primary key,
  name text,
  about text,
  created_at timestamp not null default now()
);

create table p.post (
  id                        serial primary key,
  headline                  text,
  body                      text,
  user_id                   int,
  reviewed_by               int
);

comment on column p.post.user_id is
  E'@references p.user(id)';
comment on table p.post is
  E'@foreignKey (reviewed_by) references p.user(id)';