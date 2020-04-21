@echo off
cd chrome
C:\Programme\7-Zip\7z.exe a -tzip -mx=0 -r0 crashrecovery.jar content locale
cd ..
ren chrome.manifest nojar.chrome.manifest
copy chrome\jar.chrome.manifest chrome.manifest
C:\Programme\7-Zip\7z.exe a -tzip -mx=9 -r0 crashrecovery.xpi chrome/crashrecovery.jar components defaults install.rdf chrome.manifest install.js license.txt
move /y nojar.chrome.manifest chrome.manifest
del chrome\crashrecovery.jar
