import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';

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
    hashObject(content){
        return crypto.createHash('sha1').update(content,'utf-8').digest('hex');

    }
    async add(fileToBeAdded){
        const fileData=await fs.readFile(fileToBeAdded,'utf-8');
        const fileHash=this.hashObject(fileData);
        console.log(fileHash);
        const newFileHashedObjectPath=path.join(this.objectpath,fileHash);
        await fs.writeFile(newFileHashedObjectPath,fileData);
        // nayi folder me file create krdi of fileData 
        // hum folder ko name de rhe hai hashed object ka 
        // git hashed file ke first 2 char se folder name deta hai and bache hue 38 se file name (blob)

        
        // one step is missing adding it to the staging area 
        await this.updateStagingArea(fileToBeAdded,fileHash);
        console.log(`added ${fileToBeAdded}`);

    }
    async updateStagingArea(filepath,filehash){
        const index=JSON.parse(await fs.readFile(this.indexpath,{encoding:'utf-8'}));
        index.push({path:filepath,hash:filehash})
        await fs.writeFile(this.indexpath,JSON.stringify(index));

    }

    // commit function important the heart of this program
    async commit(message){
        const index=JSON.parse(await fs.readFile(this.indexpath,{encoding:'utf-8'}));
        // index se data padh liya 
        const parentCommit=await this.getCurrentHead();

        const commitData={
            timestamp:new Date().toISOString(),
            message,
            files:index,
            parent:parentCommit
        };
        const commitHash=this.hashObject(JSON.stringify(commitData));
        const commitPath=path.join(this.objectpath,commitHash);
        await fs.writeFile(commitPath,JSON.stringify(commitData));
        await fs.writeFile(this.headpath,commitHash);
        // head path jo hai vo previous commited hash ko point karega 
        await fs.writeFile(this.indexpath,JSON.stringify([]));

        console.log(`commit sucessfully created ${commitHash}`);

    }


    async getCurrentHead(){
        try{
            //return await fs.readFile(this.headpath,{encoding:'utf-8'});
            return await fs.readFile(this.headpath,{encoding:'utf-8'});
        }
        catch(error){
            console.log("error in getCurrentHead()");
            console.log(error);
        }
        
    }

    async log(){
        let currentCummitHash=await this.getCurrentHead();
        while(currentCummitHash){
            const commitData=await JSON.parse(await fs.readFile(path.join(this.objectpath,currentCummitHash),{encoding:'utf-8'}));
          
          //this is what happens inside the join isliye use krna hai ise 
          
            //path.join(this.objectpath, currentCummitHash)
           //.mygit/objects/1c61c5bfab86cafcb0bb2def557330a00cb98c3a




            console.log(`commit: ${currentCummitHash}`);
            console.log(`Date: ${commitData.timestamp}`);
            console.log(`\n\t${commitData.message}\n`);


            // imp
            currentCummitHash=commitData.parent;
        }
    }
}


// (async()=>{
//     const git=new mygit();
//     await git.add('text1.txt');
//     await git.commit("Initial commit");
// })();
const git=new mygit();
await git.add('text1.txt');
await git.commit("Initial commit");
// await git.commit("second commit");
await git.log();
