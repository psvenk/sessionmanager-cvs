@echo off
call make_xpi.cmd
copy components\crashrecovery.* z~crashrecovery\components\
cd z~crashrecovery
call make_xpi.cmd
del components\crashrecovery.*
move crashrecovery.xpi ..
cd ..
