@echo off
cd chrome
C:\Programme\7-Zip\7z.exe a -tzip -mx=0 -r0 sessionmanager.jar content locale skin
cd ..
ren chrome.manifest nojar.chrome.manifest
copy z~misc\jar.chrome.manifest chrome.manifest
C:\Programme\7-Zip\7z.exe a -tzip -mx=9 -r0 sessionmanager.xpi chrome/sessionmanager.jar components defaults install.rdf chrome.manifest install.js license.txt chrome/icons
move /y nojar.chrome.manifest chrome.manifest
del chrome\sessionmanager.jar
