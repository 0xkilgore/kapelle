# Retained Task publication plan: hard-link installation and reads

The original plan is still installed with `link(temp, final)`, which refuses an
existing final name, after fsync of the complete owner-only temporary file. No
rename-overwrite, replacement plan, regenerated timestamp or cleanup-on-lookup is
introduced. Before final installation, an abandoned temporary file is not a plan.
After installation, it is the original plan even if the installer dies before
unlinking its temporary name. Native publication has not yet begun at that point.

The reader accepts one link normally. For exactly two links it requires the other
link to be a regular file with matching device/inode and private ownership/mode,
in the same canonical owner-only receipt directory, named exactly
`<final-name>.<UUID-v4>.tmp`. This accounts for all links. An unexplained or external
link, extra link, symlink alias or unsafe permissions remains an error. Alias opens
use NOFOLLOW and NONBLOCK; an unsafe special file cannot block recovery. Unrelated
regular staging files are not counted as aliases. Access to this private directory
is already part of the trusted host/configuration boundary; a staging name is not
an authorization credential. Request, admission and plan-digest validation remain
mandatory after the filesystem read.

An installer can unlink the alias during inspection or reading. The reader retries
that 2-to-1 transition, closing its descriptor and reopening the final file, up to
three attempts. It still checks stable size, mtime, owner, mode, ctime/link count and
final pathname device/inode. It does not ignore arbitrary ctime changes. A settled
two-link crash artifact remains intact indefinitely; lookup performs no cleanup,
chmod, timestamp regeneration, lock release or native/receipt write.

Tests intercept the actual built-in link call only in a child test process (no
production fault hook): SIGKILL immediately after installation; a separate reader
while that call is held before unlink; and a controlled installer unlink during a
descriptor read. Repeated read-only recovery and explicit pre-native-write retry
preserve exact original plan bytes/timestamp. Changed request/admission refuses
publication without overwriting that plan. Other tests retain the arbitrary-link,
symlink and mode protections. These are local process-loss/synthetic-state proofs,
not power-loss, live-provider or production-storage qualification.
