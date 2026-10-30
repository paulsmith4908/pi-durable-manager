# User-owned worker permissions

The plugin does not install AGENTS.md into new or imported projects. Repository guidance
is optional user-owned content, not the worker authorization store.

Read `permissions.read {projectId}` for the effective policy, source and revision.
Optional `assignmentId` returns the immutable policy recorded at admission. Without a
projectId, read/change the default inherited by projects without an explicit override.
Existing development-network consent is preserved until the operator changes it.

`permissions.set` takes optional projectId, expectedRevision, requestId and a complete
policy: writeFiles, shell, network, hostValidation (booleans), excludedPaths (literal
project-relative files/directories). Shell requires file editing; arbitrary shell is
not a read-only capability. Protected secrets, Git metadata and manager state cannot
be unlocked by these controls. Exclusions add protection; they never remove it.

The Settings view supports the same controls under Worker permissions. Changes are
audited and refuse affected writer leases. Safely stop/join work before changing policy;
then admit fresh work. Do not treat a permission request as an ordinary design question.
Only a user-authorized change can expand capabilities. Explicitly report unsupported
permissions instead of promising a prompt can enforce arbitrary shell behavior.

Git/release operations require separately authorized manager actions in this release.
Shell and networking do not authorize publication or credential access. Keep private
operator links and permission state outside the worker checkout. Existing AGENTS.md
files are never automatically rewritten or deleted during upgrade.
