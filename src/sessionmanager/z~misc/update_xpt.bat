@ECHO OFF
CD ..\..\xpidl
xpidl -m typelib -w -v -e ..\sessionmanager\components\crashrecovery.xpt ..\sessionmanager\z~misc\crashrecovery.idl
PAUSE
