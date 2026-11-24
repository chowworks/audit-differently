# Signed commits (Mac and Windows)

Branch protection on `main` needs **every commit in a PR to have a verified signature**. Without one, GitHub shows:

> Merging is blocked
> Commits must have verified signatures.

Set this up once per computer. About 5 minutes. This guide uses **SSH signing**: no GPG install, same steps on Mac and PC.

## 1. Check for an SSH key

Mac (Terminal) or Windows (PowerShell, or Git Bash):

```sh
ls ~/.ssh/id_ed25519.pub
```

File exists: skip to step 3. Not found: step 2.

## 2. Make a key

```sh
ssh-keygen -t ed25519 -C "your-github-email@example.com"
```

Press Enter for the default path. Set a passphrase.

### Load it into the SSH agent

**Mac:**

```sh
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

**Windows (PowerShell as Administrator, once):**

```powershell
Set-Service ssh-agent -StartupType Manual
Start-Service ssh-agent
```

Then, in a normal PowerShell:

```powershell
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

## 3. Tell Git to sign with it

Same on both (Terminal, PowerShell or Git Bash):

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

`user.email` must be an address **verified on your GitHub account** (or your GitHub `noreply` address). Check:

```sh
git config --global user.email
```

Wrong or unverified email = commit shows "Unverified" even when signed.

**Windows only:** if signing fails with `error: unable to start ssh-keygen` or similar, point Git at Windows' OpenSSH:

```powershell
git config --global gpg.ssh.program "C:/Windows/System32/OpenSSH/ssh-keygen.exe"
```

## 4. Add the key to GitHub as a *signing* key

This is the step people miss. An authentication key does **not** sign.

1. Copy the public key:
   - Mac: `pbcopy < ~/.ssh/id_ed25519.pub`
   - Windows PowerShell: `Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard`
2. GitHub → Settings → SSH and GPG keys → **New SSH key**.
3. **Key type: Signing Key.** Paste. Save.

If you already added the same key as an Authentication key, add it again as a Signing Key. GitHub allows both.

## 5. Check it works

```sh
git commit --allow-empty -m "test signing"
git log --show-signature -1
```

Locally, `git log --show-signature` may say `No signature` / `gpg.ssh.allowedSignersFile needs to be configured`. That is a local-only check. To fix it:

```sh
echo "your-github-email@example.com $(cat ~/.ssh/id_ed25519.pub)" > ~/.ssh/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
```

The real test: push a branch, open the commit on GitHub. A green **Verified** badge = done. Drop the test commit (`git reset --hard HEAD~1`) before pushing real work.

## Already blocked? Sign the commits you already made

Finish steps 1 to 4 first. Then, on your PR branch (replace `main` if your base differs):

```sh
git fetch origin
git rebase --exec 'git commit --amend --no-edit -S' origin/main
git push --force-with-lease
```

This rewrites your own branch's commits. Do it only on a branch you alone work on. Never on `main`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Merging is blocked` persists after push | Old commits still unsigned | Rebase command above |
| Badge says **Unverified** | Key not added as *Signing Key*, or commit email not verified on GitHub | Step 4; check `git config user.email` |
| `error: Load key ... incorrect passphrase` / `agent refused operation` | Key not in agent | `ssh-add` (step 2) |
| `Couldn't load public key` | `user.signingkey` path wrong | Point it at the `.pub` file |
| Mac asks passphrase every time | Not stored in Keychain | `ssh-add --apple-use-keychain ...` |
| Windows: `unable to start ssh-keygen` | Git can't find OpenSSH | `gpg.ssh.program` line in step 3 |
| Commits made in GitHub's web editor | GitHub signs these itself | Nothing to do |
| Another repo shouldn't sign | Global setting applies everywhere | `git config commit.gpgsign false` inside that repo |

## Prefer GPG?

Works too, but more setup. Follow GitHub's guide: <https://docs.github.com/en/authentication/managing-commit-signature-verification/generating-a-new-gpg-key>, then `git config --global user.signingkey <KEYID>` and `git config --global commit.gpgsign true`.

## Reference

- GitHub: [About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
- GitHub: [Telling Git about your signing key](https://docs.github.com/en/authentication/managing-commit-signature-verification/telling-git-about-your-signing-key)
