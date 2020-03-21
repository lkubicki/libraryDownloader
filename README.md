# libraryDownloader
TypeScript learning project.  
This TypeScript application lets you download the ebooks you have purchased from various publishers or ebook sellers, like:
* [Apress](https://apress.com)
* [Ebookpoint](https://ebookpoint.pl)
* [Informit](https://informit.com)
* [Manning Publishing](https://manning.com)
* [Nexto](https://nexto.pl)
* [Packt Publishing](https://packtpub.com)
* [Publio](https://publio.pl)
* [Świat Książki](https://swiatksiazki.pl)
* [Virtualo](https://virtualo.pl)
* [Woblink](https://woblink.com)

For each of these bookstores, there is a template file in /config folder (named _bookstoreName_.json.template), which you need to add as part of /config/bookstores.json file in order for your books to downloaded from your library. Of course, first you need to add your username and password, ie.:  
To configure Manning Publishing and Apress you need to have following configuration in your /config/bookstores.json file:
```json
[
  {
    "bookstoreName": "Apress",
    "moduleName": "apress",
    "controllerName": "Apress",
    "login": "MyApressLogin",
    "password": "MySecretApressPassword",
    "mainPageUrl": "https://www.apress.com/",
    "bookshelfUrl": "https://www.apress.com/public/profile/bookshelf",
    "loginFormUrl": "https://login.apress.com/public/gp/login?url=https%3A%2F%2Fwww.apress.com%2Fpublic%2Fprofile%2Fbookshelf",
    "loginServiceUrl": "https://login.apress.com/public/gp/authenticate"
  },
  {
    "bookstoreName": "Manning Publications",
    "moduleName": "manning",
    "controllerName": "Manning",
    "login": "MyManningLogin",
    "password": "MySecretManningPassword",
    "mainPageUrl": "https://www.manning.com/",
    "bookshelfUrl": "https://www.manning.com/dashboard",
    "booksListUrl" : "https://www.manning.com/dashboard/getLicensesAjax?isDropboxIntegrated=&max=1000&order=purchaseDate&sort=desc&filter=all&offset=0",
    "loginFormUrl": "https://login.manning.com/login?service=https%3A%2F%2Fwww.manning.com%2Flogin%2Fcas",
    "loginServiceUrl": "https://login.manning.com/login?service=https%3A%2F%2Fwww.manning.com%2Flogin%2Fcas"
  }
]
```
