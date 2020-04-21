const EXT_FULL_NAME = "Crash Recovery";
const EXT_SHORT_NAME = "crashrecovery";
const EXT_AUTHOR = "zeniko";
const EXT_VERSION = "0.6.10+";

const EXT_FILES = [
	["components/crashrecovery.js", Install.getFolder("Components")],
	["components/crashrecovery.xpt", Install.getFolder("Components")],
	["chrome/crashrecovery.jar", Install.getFolder("chrome")]
];
const EXT_LOCALES = ["en-US", "de-CH", "fr-FR", "pl-PL", "it-IT", "es-ES", "cs-CZ", "tr-TR", "pt-BR", "zh-TW", "lt-LT", "ru-RU", "ja-JP", "sk-SK", "he-IL", "nl-NL", "uk-UA", "hu-HU"];

const CONFIRMATION = "WARNING: You need administrator privileges to install " + EXT_FULL_NAME + ". It will be installed in the application folder for all users. Proceed with the installation?";

var isSilent = (Install.arguments == "p=0");
if (Install.arguments && !isSilent)
{
	Install.cancelInstall(Install.SILENT_MODE_DENIED);
}
else if (isSilent || Install.confirm(CONFIRMATION))
{
	var err = Install.initInstall(EXT_FULL_NAME + " " + EXT_VERSION, "/" + EXT_AUTHOR + "/" + EXT_SHORT_NAME, EXT_VERSION);
	while (err == Install.SUCCESS && EXT_FILES.length)
	{
		var file = EXT_FILES.pop();
		err = Install.addFile(EXT_SHORT_NAME, EXT_VERSION, file[0], file[1], null);
	}
	if (err == Install.SUCCESS)
	{
		var jarPath = Install.getFolder(Install.getFolder("chrome"), EXT_SHORT_NAME + ".jar");
		Install.registerChrome(Install.CONTENT | Install.DELAYED_CHROME, jarPath, "content/" + EXT_SHORT_NAME + "/");
		for (var locale in EXT_LOCALES)
		{
			var regPath = "locale/" + EXT_LOCALES[locale] + "/" + EXT_SHORT_NAME + "/";
			Install.registerChrome(Install.LOCALE | Install.DELAYED_CHROME, jarPath, regPath);
		}
		
		err = Install.performInstall();
	}
	if (err == Install.SUCCESS || err == Install.REBOOT_NEEDED)
	{
		if (!isSilent) Install.alert(EXT_FULL_NAME + " " + EXT_VERSION + " is now installed.\nIt will become active after you restart your browser.");
	}
	else
	{
		if (!isSilent) Install.alert("Installation failed: error " + err + "\n" + "You probably don't have the necessary permissions (log in as system administrator).");
		Install.cancelInstall(err);
	}
}
else
{
	Install.cancelInstall();
}
