var XpiInstaller = {
	extFullName: "Session Manager",
	extShortName: "sessionmanager",
	extVersion: "0.4.3",
	extAuthor: "zeniko",
	extLocaleNames: ["en-US", "de-CH", "it-IT", "zh-CN", "pt-BR", "fr-FR", "lt-LT", "es-ES", "pl-PL", "ja-JP", "ru-RU"],
	extSkinNames: ["classic"],
	extPostInstallMessage: null,
	
	profileInstall: true,
	silentInstall: false,

	install: function()
	{
		if (Install.arguments && (Install.arguments == "p=0" || Install.arguments == "p=1"))
		{
			this.profileInstall = (Install.arguments == "p=1");
			this.silentInstall = true;
		}
		
		/* Make sure that Crash Recovery is already installed. */
		if (!File.exists(Install.getFolder(Install.getFolder("Components"), "crashrecovery.js")))
		{
			if (!this.silentInstall)
			{
				Install.alert(this.extFullName + " requires the 'Crash Recovery' extension to be installed (see " + this.extFullName + "'s homepage). Please try again after you've installed Crash Recovery.");
			}
			Install.cancelInstall(Install.NO_SUCH_COMPONENT);
			return;
		}
		
		var jarName = this.extShortName + ".jar";
		var profileDir = Install.getFolder("Profile", "chrome");
		
		if (File.exists(Install.getFolder(profileDir, jarName)))
		{
			if (!this.silentInstall)
			{
				Install.alert("Updating existing Profile install of " + this.extFullName + " to version " + this.extVersion + ".");
			}
			this.profileInstall = true;
		}
		else if (!this.silentInstall)
		{
			this.profileInstall = Install.confirm("Install " + this.extFullName + " " + this.extVersion + " to your Profile directory (OK) or your Browser directory (Cancel)?");
		}
		
		var dispName = this.extFullName + " " + this.extVersion;
		var regName = "/" + this.extAuthor + "/" + this.extShortName;
		Install.initInstall(dispName, regName, this.extVersion);
		
		var installPath = (this.profileInstall)?profileDir:Install.getFolder("chrome");
		
		Install.addFile(null, "chrome/" + jarName, installPath, null);
		
		var jarPath = Install.getFolder(installPath, jarName);
		var installType = (this.profileInstall)?Install.PROFILE_CHROME:Install.DELAYED_CHROME;
		
		Install.registerChrome(Install.CONTENT | installType, jarPath, "content/" + this.extShortName + "/");
		
		for (var locale in this.extLocaleNames)
		{
			var regPath = "locale/" + this.extLocaleNames[locale] + "/" + this.extShortName + "/";
			Install.registerChrome(Install.LOCALE | installType, jarPath, regPath);
		}
		for (var skin in this.extSkinNames)
		{
			var regPath = "skin/" + this.extSkinNames[skin] + "/" + this.extShortName + "/";
			Install.registerChrome(Install.SKIN | installType, jarPath, regPath);
		}
		
		var err = Install.performInstall();
		if (err == Install.SUCCESS || err == Install.REBOOT_NEEDED)
		{
			if (!this.silentInstall && this.extPostInstallMessage)
			{
				Install.alert(this.extPostInstallMessage);
			}
		}
		else
		{
			if (!this.silentInstall)
			{
				Install.alert("Error: Could not install " + this.extFullName + " " + this.extVersion + " (Error code: " + err + ")");
			}
			Install.cancelInstall(err);
		}
	}
};

XpiInstaller.install();
