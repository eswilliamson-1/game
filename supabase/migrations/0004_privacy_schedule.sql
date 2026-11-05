-- Deletes old player data daily. Run this after 0002 and 0003.

select cron.schedule('community-game-privacy', '0 4 * * *', 'select public.purge_old_data()');
