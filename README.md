# libraryDownloader
TypeScript learning project.  
To run it, you need to have node.js and TypeScript installed.  
This TypeScript application lets you download the ebooks you have purchased from various publishers or ebook sellers, like:
* [Ebookpoint](https://ebookpoint.pl)
* [Informit](https://informit.com)
* [Manning Publishing](https://manning.com)
* [Nexto](https://nexto.pl)
* [Packt Publishing](https://packtpub.com)
* [Publio](https://publio.pl)
* [Springer](https://springer.com)
* [Świat Książki](https://swiatksiazki.pl)
* [Virtualo](https://virtualo.pl)
* [Woblink](https://woblink.com)

For each of these bookstores, there is a separate configuration file in /config/bookstores folder (named _bookstoreName_.json), which contains the configuration of the module. It needs to define at least the name of the store, module and the controller class. You will need to do anything with these files only when you define a new bookstore module or modify the configuration of an existing one.
If you only wish your books to be downloaded from the bookstore, you need to add a section in /config/bookstores.json file where you need to put the name of the module, your username and password, ie.: to configure Manning Publishing and Apress you need to have following configuration in your /config/bookstores.json file:
```json
[
  {
    "name": "springer",
    "login": "MySpringerLogin",
    "password": "MySecretSpringerPassword"
  },
  {
    "name": "manning",
    "login": "MyManningLogin",
    "password": "MySecretManningPassword"
  }
]
```
  
---       
   
<sub>If you like the downloader, you can show your appreciation by [buying me a coffee](https://www.buymeacoffee.com/lkubicki). Thank you :)</sub>
