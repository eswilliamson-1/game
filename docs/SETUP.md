# Setup

Do these in order. Each step needs your own login, so you enter every password and key yourself. Never paste them into a chat, and never commit `.env`.

## 1. Hostinger

1. In hPanel, create two subdomains: `vote.ewpages.com` and `sandbox.ewpages.com`. To use other names, change `config/settings.json` and `sandbox-host/.htaccess` to match.
2. Find each subdomain's folder under Domains > Subdomains.
3. Under Files > FTP Accounts, create two new accounts, `gamedeploy` and `votedeploy`. In the Directory field, replace `/public_html` with that subdomain's exact folder. Never leave it as `/public_html`, and don't reuse Delve's login or your main FTP account: the game account must not be able to reach the rest of the site.
4. Save each account's host, full username, and password in a password manager.

## 2. Supabase

1. Create a new project, separate from Delve's.
2. In the SQL editor, run `supabase/migrations/0001_init.sql`, `supabase/migrations/0003_accounts_privacy.sql`, `supabase/migrations/0005_username_accounts.sql`, and `supabase/migrations/0006_login_names.sql`. Skip any you've already run.
3. Under Authentication > Sign In / Providers, keep new user sign-ups on and the Email provider on, then turn off **Confirm email**. If this is left on, accounts won't work. Turn off anonymous sign-ins and every other provider, and set the minimum password length to 8. Players log in with a username and the site never sends email, so you don't need an email service.
4. Accept Supabase's data processing agreement, and note the project's region for section 5.
5. After section 5, create an account on the voting site with a strong password from your password manager. Then make yourself the owner in the SQL editor:

   ```sql
   insert into public.owners (user_id)
   select id from auth.users where email = 'YOUR-USERNAME@players.ewpages.com';
   ```

## 3. Claude API

1. In the Claude Console, create an API key for this project only.
2. Set a monthly spend limit on the workspace. Start low, such as $50.
3. Confirm that Anthropic's data processing terms cover your account.

## 4. GitHub

The repository, label, and branch protection are already set up at `eswilliamson-1/game`.

1. Run this in your own terminal. It asks for each key and password, sends them straight to GitHub, and skips anything already stored, so you can stop and run it again later.

   ```bash
   npm run setup:github
   ```

2. Create a fine-grained token limited to this repository, with Contents set to read and write. You'll use it in section 6.
3. Main is protected from deletion and force pushes. It can't require pull requests, because the release workflow pushes straight to it and personal repositories can't exempt workflows. Only you can push, so outsiders still need a pull request that you merge.
4. Don't merge pull requests from other people without reading every changed file.

## 5. Voting site

1. Copy `.env.example` to `.env` and fill it in, using the vote FTP account.
2. Fill in `privacy` in `config/settings.json`: your name or organization, a way to reach you, and the Supabase region. These appear publicly on the privacy page, and the build stops if they're empty.
3. Run `npm ci`, then `npm run shell:deploy`.

## 6. Start the timer

1. In Supabase, add two secrets under Vault: `github_repo` (`owner/name`) and `github_dispatch_token` (the token from step 4).
2. Enable the `pg_cron` and `pg_net` extensions.
3. Run `supabase/migrations/0002_schedule.sql`, `supabase/migrations/0004_privacy_schedule.sql`, `supabase/migrations/0007_public_record_timer.sql`, `supabase/migrations/0008_one_minute_pace.sql`, `supabase/migrations/0009_idea_board.sql`, and `supabase/migrations/0010_build_stage.sql`, in that order, in the SQL editor.

## 7. Check before inviting anyone

Launch waits until all of these pass.

1. Run the Attack test workflow on GitHub. It spends a small amount of API credit, and must report 0 attacks through. You can also run it locally:

   ```bash
   npm run attack-test
   ```

2. Run the First upload workflow on GitHub. This publishes the placeholder page.
3. Confirm the isolation is live. Every line must say PASS. If any says FAIL, stop: the game isn't isolated. This also runs after every release.

   ```bash
   npm run verify-live
   ```

4. Confirm the game FTP account can't list anything outside its own folder.
5. Run the Plan workflow by hand, approve the first ideas, if any are waiting, at `https://vote.ewpages.com/review.html`, upvote an idea, and watch one release all the way through.

## Everyday use

- **Review:** GitHub emails you when something needs a decision. Use `review.html`.
- **Pause:** use `review.html`.
- **Roll back:** run the Rollback workflow on GitHub.
- **Bug or security fix:** run the Build workflow by hand and describe the fix.
- **End the launch review period:** run `update settings set launch_review = false;`, and add an entry to `config/rule-changes.json`.
- **Change the rules:** edit `config/RULES.md`, add an entry to `config/rule-changes.json`, then run `npm run shell:deploy`.
- **Change the pace:** voting windows follow the number of players active in the last `active_days`. Edit `pace_tiers` in the `settings` table, and `cycle_hours` for groups larger than every tier. `plan_throttle_minutes` sets how quickly new suggestions are picked up. `maxBuildsPerDay` in `config/settings.json` caps daily AI builds.
