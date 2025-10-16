import path from 'path';
import fs from 'fs/promises';

class mygit{
    constructor(repopath='.'){
        this.repopath=path.join(repopath,'.mygit');
        // this will create a .mygit when you do init 
        this.objectpath=path.join(this.repopath,'objects');
        // .mygit/objects
        this.headpath=path.join(this.repopath,'HEAD');
        // .mygit/HEAD
        this.indexpath=path.join(this.repopath,'index');
         this.init();

    }
    async init(){
        await fs.mkdir(this.objectpath,{recursive:true});
        try{
            await fs.writeFile(this.headpath,'',{flag:'wx'});
            // create a file only if it does not exist
            await fs.writeFile(this.indexpath,JSON.stringify([]),{flag:'wx'});
            console.log('Initialized empty mygit repository.');

        }
        catch(error){
            console.log('Repository already initialized.');
        }
    }
}

const git=new mygit();