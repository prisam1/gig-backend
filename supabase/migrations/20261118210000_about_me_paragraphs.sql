-- "About me" keeps its paragraph break: the profile menu shows each paragraph on its own line, as
-- it showed the text before, and the profile screen runs them on as one. Members who still have
-- the starting text get it with the break.

alter table app.user_profiles
  alter column about_me set default
    E'Passionate about supporting ambitious founders and scalable business ideas.\nI believe in long-term value creation through strategic guidance, networking opportunities, and capital support.';

update app.user_profiles
set about_me = E'Passionate about supporting ambitious founders and scalable business ideas.\nI believe in long-term value creation through strategic guidance, networking opportunities, and capital support.'
where about_me = 'Passionate about supporting ambitious founders and scalable business ideas. I believe in long-term value creation through strategic guidance, networking opportunities, and capital support.';
